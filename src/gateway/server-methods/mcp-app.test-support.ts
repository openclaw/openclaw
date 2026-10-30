import { Type } from "typebox";
import { vi } from "vitest";
import type {
  McpCatalogTool,
  McpToolCatalog,
  SessionMcpRuntime,
} from "../../agents/agent-bundle-mcp-types.js";
import type { McpAppViewLease } from "../../agents/mcp-ui-resource.js";

export function appCatalog(
  serverName: string,
  tools: Array<Pick<McpCatalogTool, "toolName"> & Partial<McpCatalogTool>>,
  server: Partial<McpToolCatalog["servers"][string]> = {},
): McpToolCatalog {
  return {
    version: 1,
    generatedAt: 1,
    servers: {
      [serverName]: { serverName, launchSummary: serverName, toolCount: tools.length, ...server },
    },
    tools: tools.map((tool) => ({
      serverName,
      safeServerName: serverName,
      inputSchema: Type.Object({}),
      fallbackDescription: tool.toolName,
      ...tool,
    })),
  };
}

export function appView(
  owner: SessionMcpRuntime,
  overrides: Partial<McpAppViewLease> = {},
): McpAppViewLease {
  return {
    runtime: owner,
    viewId: "cv_app",
    agentId: "main",
    sessionId: owner.sessionId,
    serverName: "demo",
    toolName: "show",
    uiResourceUri: "ui://demo/app",
    html: "<html>demo</html>",
    toolInput: {},
    toolResult: { content: [] },
    expiresAtMs: Date.now() + 600_000,
    requestWindowStartedAtMs: Date.now(),
    requestCount: 0,
    toolCallCount: 0,
    activeRequests: 0,
    byteSize: 0,
    ...overrides,
  };
}

export function runtime() {
  const releaseLease = vi.fn();
  const catalog = appCatalog("demo", [
    { toolName: "shared" },
    { toolName: "app-only", uiVisibility: ["app"] },
    { toolName: "model-only", uiVisibility: ["model"] },
  ]);
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
      tools: catalog.tools.map(({ toolName, uiVisibility }) =>
        Object.assign(
          { name: toolName, inputSchema: { type: "object" as const } },
          uiVisibility ? { _meta: { ui: { visibility: uiVisibility } } } : {},
        ),
      ),
    })),
    listResources: vi.fn(async () => [{ uri: "ui://demo/state", name: "state" }]),
    listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
    readResource: vi.fn(async (_serverName: string, uri: string) => ({
      contents: [{ uri, text: "resource" }],
    })),
  };
}
