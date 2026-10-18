import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { onTestFinished, vi } from "vitest";
import type { resolveMcpTransport } from "../agents/mcp-transport.js";
import { startNodeHostMcpManager as startManager } from "./mcp.js";

const { clientConstructor, resolveTransport } = vi.hoisted(() => ({
  clientConstructor: vi.fn(),
  resolveTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modelcontextprotocol/sdk/client/index.js")>()),
  Client: clientConstructor,
}));
// mock-isolation: Fixtures own transport lifetimes instead of opening real MCP connections.
vi.mock("../agents/mcp-transport.js", () => ({ resolveMcpTransport: resolveTransport }));

type TransportFixture = Pick<
  NonNullable<ReturnType<typeof resolveMcpTransport>>,
  "transport" | "transportType" | "connectionTimeoutMs" | "requestTimeoutMs" | "detachStderr"
>;

type ClientFixture = {
  onclose?: () => void;
  request(request: ListToolsRequest, schema: unknown, options?: RequestOptions): Promise<unknown>;
  callTool(
    params: CallToolRequest["params"],
    schema?: undefined,
    options?: RequestOptions,
  ): Promise<CallToolResult>;
};

export function startNodeHostMcpManager(
  servers: Parameters<typeof startManager>[0],
  options: NonNullable<Parameters<typeof startManager>[1]> & {
    createClient: (serverName: string, options: { onToolsChanged: () => void }) => ClientFixture;
    resolveTransport: (serverName: string) => TransportFixture | null;
    warn?: (message: string) => void;
  },
) {
  // Transport resolution and client construction share one synchronous startup step.
  let connectingServer = "";
  resolveTransport.mockImplementation((serverName: string) => {
    connectingServer = serverName;
    return options.resolveTransport(serverName);
  });
  clientConstructor.mockImplementation(function (
    _identity: unknown,
    clientOptions: { listChanged: { tools: { onChanged: () => void } } },
  ) {
    const client = options.createClient(connectingServer, {
      onToolsChanged: clientOptions.listChanged.tools.onChanged,
    });
    return {
      ...client,
      get onclose() {
        return client.onclose;
      },
      set onclose(callback: ClientFixture["onclose"]) {
        Object.assign(client, { onclose: callback });
      },
      request(
        request: ListToolsRequest | CallToolRequest,
        schema: unknown,
        requestOptions?: RequestOptions,
      ) {
        return request.method === "tools/call"
          ? client.callTool(request.params, undefined, requestOptions)
          : client.request(request, schema, requestOptions);
      },
    };
  });
  const warnings = vi.spyOn(console, "warn").mockImplementation(options.warn ?? (() => {}));
  onTestFinished(() => warnings.mockRestore());
  return startManager(servers, {
    signal: options.signal,
    onDescriptorsChanged: options.onDescriptorsChanged,
  });
}
