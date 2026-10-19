import "./mcp-manager.test-support.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { vi } from "vitest";

const { startNodeHostMcpManager } = await import("./mcp-manager.test-support.js");

type ManagerOptions = Parameters<typeof startNodeHostMcpManager>[1];
type ManagerDeps = Omit<ManagerOptions, "resolveTransport"> &
  Partial<Pick<ManagerOptions, "resolveTransport">>;
type Client = ReturnType<NonNullable<ManagerDeps["createClient"]>>;
type CallOptions = Parameters<Client["callTool"]>[1];
type ClientParams = {
  connectError?: Error;
  connect?: () => Promise<void>;
  tools?: Tool[] | (() => Tool[]);
  list?: (
    input?: { cursor?: string },
    options?: { timeout?: number },
  ) => Promise<{ tools: Tool[]; nextCursor?: string }>;
  call?: (
    input: Parameters<Client["callTool"]>[0],
    options: CallOptions,
  ) => Promise<CallToolResult>;
};

export const okResult: CallToolResult = { content: [{ type: "text", text: "ok" }] };
export const transport = {
  transport: {} as never,
  transportType: "stdio" as const,
  connectionTimeoutMs: 100,
  requestTimeoutMs: 50,
};

export function createClient(params: ClientParams = {}) {
  return {
    onclose: undefined as (() => void) | undefined,
    onToolsChanged: undefined as (() => void) | undefined,
    connect: vi.fn(async () => {
      if (params.connectError) {
        throw params.connectError;
      }
      return params.connect?.();
    }),
    request: vi.fn<Client["request"]>(async (request, options) =>
      params.list
        ? params.list(request.params, options)
        : { tools: typeof params.tools === "function" ? params.tools() : (params.tools ?? []) },
    ),
    callTool: vi.fn<Client["callTool"]>(async (input, options) =>
      params.call ? params.call(input, options) : { content: [{ type: "text", text: "ok" }] },
    ),
    close: vi.fn(async () => {}),
  };
}

export function startManager(
  deps: ManagerDeps,
  servers: Parameters<typeof startNodeHostMcpManager>[0] = { docs: { command: "docs" } },
) {
  return startNodeHostMcpManager(servers, {
    resolveTransport: () => transport,
    warn: vi.fn(),
    ...deps,
    createClient: (name, options) => {
      const client = deps.createClient(name, options);
      Object.assign(client, { onToolsChanged: options.onToolsChanged });
      return client;
    },
  });
}

export function callTool(
  manager: Awaited<ReturnType<typeof startManager>>,
  tool: string,
  options: Partial<Parameters<typeof manager.callMcpTool>[0]> = {},
) {
  return manager.callMcpTool({ server: "docs", tool, ...options });
}
