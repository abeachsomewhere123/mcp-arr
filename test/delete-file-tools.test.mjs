import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

// Schema-level regression test: confirms the two file-delete tools are
// registered and shaped correctly. Does not hit a real Sonarr/Radarr instance
// -- see README's "Manual test against a real/staging Sonarr" note for that.
test("sonarr_delete_episode_file and radarr_delete_movie_file are registered", async () => {
  const port = String(34000 + Math.floor(Math.random() * 1000));
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: port,
      // Sonarr/Radarr tools are only registered in the TOOLS list when the
      // service is configured (see the `if (clients.sonarr)` / `if
      // (clients.radarr)` gates in src/index.ts) -- dummy values are enough
      // since this test never actually calls out to either service.
      SONARR_URL: "http://localhost:0",
      SONARR_API_KEY: "test-key",
      RADARR_URL: "http://localhost:0",
      RADARR_API_KEY: "test-key",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForHealth(port);

    await postMcp(port, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
    });

    const toolsResponse = await postMcp(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await parseMcpResponse(toolsResponse);
    const names = body.result.tools.map((t) => t.name);

    assert.ok(names.includes("sonarr_delete_episode_file"));
    assert.ok(names.includes("radarr_delete_movie_file"));

    const episodeTool = body.result.tools.find((t) => t.name === "sonarr_delete_episode_file");
    assert.deepEqual(episodeTool.inputSchema.required, ["episodeFileId"]);

    const movieTool = body.result.tools.find((t) => t.name === "radarr_delete_movie_file");
    assert.deepEqual(movieTool.inputSchema.required, ["movieFileId"]);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
});

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP server did not become healthy: ${lastError}`);
}

function postMcp(port, payload) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(payload),
  });
}

// The streamable-HTTP transport may reply as plain JSON or as an SSE frame
// (`event: message\ndata: {...}\n\n`) depending on content negotiation --
// handle both rather than assuming response.json() will work.
async function parseMcpResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`No "data:" line found in SSE response body: ${text}`);
  }
  return JSON.parse(dataLine.slice("data: ".length));
}
