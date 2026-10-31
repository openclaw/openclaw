import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, vi } from "vitest";
import * as httpFixture from "../../test/helpers/gateway-integration-fixtures.js";
import {
  createStandaloneHostBrowserHarness,
  type StandaloneHostBrowserOptions,
} from "./mcp-app-standalone.browser.test-support.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const mocks = vi.hoisted(() => ({
  completeRetirement: vi.fn(),
  getMcpAppViewLease: vi.fn(),
  peekSessionMcpRuntime: vi.fn(),
}));

vi.mock("../agents/agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: mocks.peekSessionMcpRuntime,
}));
vi.mock("../agents/agent-bundle-mcp-manager-cleanup.js", () => ({
  completeDeferredSessionMcpRuntimeRetirement: mocks.completeRetirement,
}));
vi.mock("../agents/mcp-ui-resource.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/mcp-ui-resource.js")>()),
  getMcpAppViewLease: mocks.getMcpAppViewLease,
}));

// Keep exported production bindings local: Vitest's mock hoisting rewrites static
// imports but not their export specifiers, leaving those exports undefined.
const { executeMcpAppOperation, resolveMcpAppActiveView } = await import("./mcp-app-operations.js");
const { createMcpAppStandaloneTicket, handleMcpAppStandaloneHttpRequest } =
  await import("./mcp-app-standalone.js");

export function issueTicket(
  params: Omit<Parameters<typeof createMcpAppStandaloneTicket>[0], "toolOperationsAuthorized"> & {
    toolOperationsAuthorized?: boolean;
    nowMs?: number;
  },
) {
  const { nowMs: issuedAt = nowMs, ...ticketParams } = params;
  vi.spyOn(Date, "now").mockReturnValue(issuedAt);
  return expectDefined(
    createMcpAppStandaloneTicket({
      ...ticketParams,
      toolOperationsAuthorized: params.toolOperationsAuthorized ?? true,
    }),
    "ticket capacity unexpectedly exhausted",
  );
}

export let nowMs = 1_800_000_000_000;
afterEach(() => vi.restoreAllMocks());
const ports = { gatewayPort: 18_789, sandboxPort: 18_790 };
const viewPath = "/__openclaw__/mcp-app/view";
const catalogTools = () => [
  { serverName: "demo", toolName: "shared" },
  { serverName: "demo", toolName: "app-only", uiVisibility: ["app"] },
  { serverName: "demo", toolName: "model-only", uiVisibility: ["model"] },
  { serverName: "other", toolName: "cross-only", uiVisibility: ["app"] },
];
const viewDefaults = () => ({
  allowedAppToolNames: new Set(["shared", "app-only"]),
  authorizeAppInteraction: undefined as (() => boolean | Promise<boolean>) | undefined,
  expiresAtMs: nowMs + 10 * 60_000,
  requestWindowStartedAtMs: nowMs,
  requestCount: 0,
  toolCallCount: 0,
  activeRequests: 0,
});
export const releaseRuntimeLease = vi.fn();
export const runtime = {
  sessionId: "runtime-session",
  mcpAppsEnabled: true,
  markUsed: vi.fn(),
  acquireLease: vi.fn(() => releaseRuntimeLease),
  getCatalog: vi.fn(async () => ({ tools: catalogTools() })),
  callTool: vi.fn(async (serverName: string, toolName: string) => ({
    content: [{ type: "text", text: `${serverName}:${toolName}` }],
  })),
  listTools: vi.fn(async () => ({
    tools: catalogTools()
      .filter(({ serverName }) => serverName === "demo")
      .map(({ toolName, uiVisibility }) =>
        Object.assign(
          { name: toolName, inputSchema: { type: "object" } },
          uiVisibility ? { _meta: { ui: { visibility: uiVisibility } } } : {},
        ),
      ),
  })),
  listResources: vi.fn(async () => [{ uri: "ui://demo/state", name: "state" }]),
  listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
  readResource: vi.fn(async (serverName: string, uri: string) => ({
    contents: [{ uri, text: `${serverName}:${uri}` }],
  })),
};
export const view = {
  viewId: "mcp-app-view",
  agentId: "main",
  sessionId: runtime.sessionId,
  runtime,
  serverName: "demo",
  toolName: "weather",
  uiResourceUri: "ui://demo/app",
  html: "<!doctype html><p>private fixture</p>",
  csp: { connectDomains: ["https://api.example.com"] },
  toolInput: { city: "Paris" },
  toolResult: { content: [{ type: "text", text: "sunny" }] },
  ...viewDefaults(),
  byteSize: 100,
};

export async function request(params: {
  url: string;
  method?: "GET" | "HEAD" | "POST";
  authorization?: string;
  clock?: () => number;
  now?: number;
  body?: unknown;
  beforeBody?: () => void;
  socket?: EventEmitter;
}) {
  const { res, end } = makeMockHttpResponse();
  Object.assign(res, { socket: null });
  const serialized = params.body === undefined ? undefined : JSON.stringify(params.body);
  async function* body() {
    if (serialized !== undefined) {
      params.beforeBody?.();
      yield serialized;
    }
  }
  const req = Object.assign(Readable.from(body()), {
    url: params.url,
    method: params.method ?? "GET",
    headers: {
      ...(params.authorization ? { authorization: params.authorization } : {}),
      ...(serialized ? { "content-type": "application/json" } : {}),
    },
    socket: params.socket ?? new EventEmitter(),
  }) as IncomingMessage;
  vi.spyOn(Date, "now").mockImplementation(params.clock ?? (() => params.now ?? nowMs));
  const handled = await handleMcpAppStandaloneHttpRequest(req, res, ports);
  return { handled, res, end };
}

export async function startStandaloneHttp(
  options: Parameters<typeof handleMcpAppStandaloneHttpRequest>[2] = ports,
) {
  const server = createServer((req, res) => {
    void handleMcpAppStandaloneHttpRequest(req, res, options).catch(() => res.destroy());
  });
  const origin = await httpFixture.listenLoopback(server);
  return { origin, close: () => httpFixture.closeHttpServer(server) };
}

export async function createSerializedHost(options: StandaloneHostBrowserOptions = {}) {
  const shell = await request({ url: "/__openclaw__/mcp-app" });
  const source = expectDefined(
    /<script>([\s\S]+)<\/script>/u.exec(String(shell.end.mock.calls[0]?.[0]))?.[1],
    "standalone shell script missing",
  );
  const ticket = issueTicket({ sessionKey: "agent:main:main", view, nowMs }).ticket;
  const loaded = await request({ url: viewPath, authorization: `MCP-App ${ticket}` });
  const payload: unknown = JSON.parse(String(loaded.end.mock.calls[0]?.[0]));
  return await createStandaloneHostBrowserHarness({ source, ticket, payload, ...options });
}

export function resetStandaloneMcpAppTestState() {
  // Expire the preceding case through the normal ticket lifecycle.
  nowMs += 15 * 60_000;
  vi.spyOn(Date, "now").mockReturnValue(nowMs);
  vi.clearAllMocks();
  mocks.completeRetirement.mockResolvedValue(undefined);
  Object.assign(view, viewDefaults(), { readOnly: undefined });
  mocks.peekSessionMcpRuntime.mockReturnValue(runtime);
  mocks.getMcpAppViewLease.mockReturnValue(view);
}

export {
  createMcpAppStandaloneTicket,
  executeMcpAppOperation,
  handleMcpAppStandaloneHttpRequest,
  mocks,
  resolveMcpAppActiveView,
};
