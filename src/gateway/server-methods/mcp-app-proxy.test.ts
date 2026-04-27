import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupBundleMcpHarness,
  makeTempDir,
  writeExecutable,
} from "../../agents/pi-bundle-mcp-test-harness.js";
import {
  getOrCreateSessionMcpRuntime,
  getSessionMcpRuntimeManager,
  materializeBundleMcpToolsForRun,
} from "../../agents/pi-bundle-mcp-tools.js";
import { withTempHomeConfig } from "../../config/test-helpers.js";
import { mcpAppProxyHandlers } from "./mcp-app-proxy.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const require = createRequire(import.meta.url);
const SDK_SERVER_MCP_PATH = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const SDK_SERVER_STDIO_PATH = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");

afterEach(async () => {
  await cleanupBundleMcpHarness();
});

async function writeMcpAppProxyServer(scriptPath: string, startupCounterPath: string) {
  await writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
import fsp from "node:fs/promises";
import { McpServer } from ${JSON.stringify(SDK_SERVER_MCP_PATH)};
import { StdioServerTransport } from ${JSON.stringify(SDK_SERVER_STDIO_PATH)};

let current = 0;
try {
  current = Number.parseInt((await fsp.readFile(${JSON.stringify(startupCounterPath)}, "utf8")).trim(), 10) || 0;
} catch {}
await fsp.writeFile(${JSON.stringify(startupCounterPath)}, String(current + 1), "utf8");

const resourceUri = "ui://proxy/view.html";
const server = new McpServer({ name: "mcp-app-proxy-test", version: "1.0.0" });
server.registerTool(
  "model_tool",
  {
    description: "Model-visible app tool",
    inputSchema: {},
    _meta: { ui: { resourceUri } },
  },
  async (args) => ({ content: [{ type: "text", text: "model:" + JSON.stringify(args) }] }),
);
server.registerTool(
  "model_only_tool",
  {
    description: "Model-only tool",
    inputSchema: {},
    _meta: { ui: { visibility: ["model"] } },
  },
  async () => ({ content: [{ type: "text", text: "blocked" }] }),
);
server.registerTool(
  "app_only_tool",
  {
    description: "App-only tool",
    inputSchema: {},
    _meta: { ui: { visibility: ["app"] } },
  },
  async () => ({ content: [{ type: "text", text: "app-only" }] }),
);
server.registerResource(
  "proxy_view",
  resourceUri,
  { mimeType: "text/html;profile=mcp-app" },
  async () => ({
    contents: [{ uri: resourceUri, mimeType: "text/html;profile=mcp-app", text: "<html>proxy</html>" }],
  }),
);

await server.connect(new StdioServerTransport());
`,
  );
}

async function callProxy(
  method: keyof typeof mcpAppProxyHandlers,
  params: Record<string, unknown>,
) {
  let response: { ok: true; payload: unknown } | { ok: false; error: unknown } | undefined;
  await mcpAppProxyHandlers[method]({
    params,
    respond: (ok, payload, error) => {
      response = ok ? { ok: true, payload } : { ok: false, error };
    },
    req: { type: "req", id: "1", method, params },
    client: null,
    isWebchatConnect: () => false,
    context: {} as GatewayRequestHandlerOptions["context"],
  });
  if (!response) {
    throw new Error("proxy handler did not respond");
  }
  return response;
}

describe("mcp app proxy gateway methods", () => {
  it("reuses the existing session runtime and enforces app-callable tools", async () => {
    const workspaceDir = await makeTempDir("openclaw-mcp-app-proxy-");
    const startupCounterPath = path.join(workspaceDir, "starts.txt");
    const serverScriptPath = path.join(workspaceDir, "mcp-app-server.mjs");
    await writeMcpAppProxyServer(serverScriptPath, startupCounterPath);

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-proxy",
      sessionKey: "agent:test:session-proxy",
      workspaceDir,
      cfg: {
        mcp: {
          apps: { enabled: true },
          servers: {
            proxyServer: {
              command: "node",
              args: [serverScriptPath],
            },
          },
        },
      },
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    expect(materialized.tools.map((tool) => tool.name).toSorted()).toEqual([
      "proxyServer__model_only_tool",
      "proxyServer__model_tool",
    ]);

    const resources = await callProxy("mcp.listResources", {
      sessionKey: "agent:test:session-proxy",
      serverName: "proxyServer",
    });
    if (!resources.ok) {
      throw new Error(`listResources failed: ${JSON.stringify(resources.error)}`);
    }
    expect(resources.payload).toMatchObject({
      resources: [{ uri: "ui://proxy/view.html" }],
    });

    const tools = await callProxy("mcp.listTools", {
      sessionKey: "agent:test:session-proxy",
      serverName: "proxyServer",
    });
    if (!tools.ok) {
      throw new Error(`listTools failed: ${JSON.stringify(tools.error)}`);
    }
    expect(tools.payload).toMatchObject({
      tools: [
        {
          name: "model_tool",
          description: "Model-visible app tool",
          _meta: { ui: { resourceUri: "ui://proxy/view.html" } },
        },
        {
          name: "app_only_tool",
          description: "App-only tool",
          _meta: { ui: { visibility: ["app"] } },
        },
      ],
    });
    expect(JSON.stringify(tools.payload)).not.toContain("model_only_tool");

    const toolResult = await callProxy("mcp.callTool", {
      sessionKey: "agent:test:session-proxy",
      serverName: "proxyServer",
      toolName: "model_tool",
      arguments: { answer: 42 },
    });
    if (!toolResult.ok) {
      throw new Error(`callTool failed: ${JSON.stringify(toolResult.error)}`);
    }
    expect(toolResult.payload).toMatchObject({
      content: [{ type: "text" }],
    });
    expect(JSON.stringify(toolResult.payload)).toContain("model:");

    const blocked = await callProxy("mcp.callTool", {
      sessionKey: "agent:test:session-proxy",
      serverName: "proxyServer",
      toolName: "model_only_tool",
    });
    if (blocked.ok) {
      throw new Error(`model-only tool unexpectedly succeeded: ${JSON.stringify(blocked.payload)}`);
    }
    expect(JSON.stringify(blocked.error)).toContain("not app-callable");

    expect(getSessionMcpRuntimeManager().getExisting("session-proxy")).toBe(runtime);
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("1");
  });

  it("rejects app bridge calls when MCP Apps are disabled", async () => {
    const workspaceDir = await makeTempDir("openclaw-mcp-app-proxy-disabled-");
    const startupCounterPath = path.join(workspaceDir, "starts.txt");
    const serverScriptPath = path.join(workspaceDir, "mcp-app-server.mjs");
    await writeMcpAppProxyServer(serverScriptPath, startupCounterPath);

    await getOrCreateSessionMcpRuntime({
      sessionId: "session-proxy-disabled",
      sessionKey: "agent:test:session-proxy-disabled",
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            proxyServer: {
              command: "node",
              args: [serverScriptPath],
            },
          },
        },
      },
    });

    const tools = await callProxy("mcp.listTools", {
      sessionKey: "agent:test:session-proxy-disabled",
      serverName: "proxyServer",
    });
    expect(tools.ok).toBe(false);
    if (tools.ok) {
      throw new Error("listTools unexpectedly succeeded");
    }
    expect(JSON.stringify(tools.error)).toContain("MCP Apps are disabled");
  });

  it("recreates a runtime for restored app views after gateway restart", async () => {
    const workspaceDir = await makeTempDir("openclaw-mcp-app-proxy-restored-");
    const startupCounterPath = path.join(workspaceDir, "starts.txt");
    const serverScriptPath = path.join(workspaceDir, "mcp-app-server.mjs");
    await writeMcpAppProxyServer(serverScriptPath, startupCounterPath);

    await withTempHomeConfig(
      {
        mcp: {
          apps: { enabled: true },
          servers: {
            proxyServer: {
              command: "node",
              args: [serverScriptPath],
            },
          },
        },
      },
      async () => {
        const sessionKey = "agent:test:restored";
        expect(getSessionMcpRuntimeManager().resolveSessionId(sessionKey)).toBeUndefined();

        const tools = await callProxy("mcp.listTools", {
          sessionKey,
          serverName: "proxyServer",
        });
        if (!tools.ok) {
          throw new Error(`listTools failed: ${JSON.stringify(tools.error)}`);
        }
        expect(tools.payload).toMatchObject({
          tools: [
            {
              name: "model_tool",
              description: "Model-visible app tool",
              _meta: { ui: { resourceUri: "ui://proxy/view.html" } },
            },
            {
              name: "app_only_tool",
              description: "App-only tool",
              _meta: { ui: { visibility: ["app"] } },
            },
          ],
        });

        const sessionId = getSessionMcpRuntimeManager().resolveSessionId(sessionKey);
        expect(sessionId).toBe(`mcp-app:${sessionKey}`);
        expect(getSessionMcpRuntimeManager().getExisting(sessionId ?? "")).toBeTruthy();
        expect(await fs.readFile(startupCounterPath, "utf8")).toBe("1");
      },
    );
  });
});
