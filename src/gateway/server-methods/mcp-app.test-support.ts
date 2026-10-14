import { Type } from "typebox";
import { vi } from "vitest";
import type { McpToolCatalog, SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";

export function runtime() {
  const releaseLease = vi.fn();
  const catalog: McpToolCatalog = {
    version: 1,
    generatedAt: 1,
    servers: { demo: { serverName: "demo", launchSummary: "demo", toolCount: 3 } },
    tools: [
      { serverName: "demo", toolName: "shared" },
      { serverName: "demo", toolName: "app-only", uiVisibility: ["app"] as Array<"app" | "model"> },
      {
        serverName: "demo",
        toolName: "model-only",
        uiVisibility: ["model"] as Array<"app" | "model">,
      },
    ].map((tool) =>
      Object.assign(tool, {
        safeServerName: "demo",
        fallbackDescription: tool.toolName,
        inputSchema: Type.Object({}),
      }),
    ),
  };
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    configFingerprint: "gateway-bridge-fixture",
    createdAt: 1,
    lastUsedAt: 1,
    dispose: vi.fn(async () => {}),
    mcpAppsEnabled: true,
    markUsed: vi.fn(),
    acquireLease: vi.fn(() => releaseLease),
    workspaceDir: "/workspace",
    getCatalog: vi.fn(async () => catalog),
    peekCatalog: vi.fn(() => catalog),
    callTool: vi.fn<SessionMcpRuntime["callTool"]>(async (_serverName, toolName) => ({
      content: [{ type: "text", text: toolName }],
    })),
    listTools: vi.fn<NonNullable<SessionMcpRuntime["listTools"]>>(async () => ({
      tools: [
        { name: "shared", inputSchema: { type: "object" } },
        {
          name: "app-only",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: ["app"] } },
        },
        {
          name: "model-only",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    })),
    listResources: vi.fn(async () => [{ uri: "ui://demo/state", name: "state" }]),
    listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
    readResource: vi.fn(async (_serverName: string, uri: string) => ({
      contents: [{ uri, text: "resource" }],
    })),
  };
}
