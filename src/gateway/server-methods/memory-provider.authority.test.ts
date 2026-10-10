// Gateway dispatch of provider-neutral memory reads: method scopes, caller kinds,
// and request currency, through the real handlers and provider acquisition.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemorySearchResult } from "../../memory-host-sdk/host/types.js";
import type { MemoryProviderHandle } from "../../plugins/memory-provider-types.js";
import type {
  MemoryPluginRuntime,
  MemoryProviderRuntime,
  RegisteredMemorySearchManager,
} from "../../plugins/registry-contribution-types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type Client = NonNullable<Parameters<typeof handleGatewayRequest>[0]["client"]>;

const providerConfig: OpenClawConfig = { agents: { entries: { main: {} } } };
let config = providerConfig;
const reference = { providerId: "records", id: "claim:42" };

function createProvider() {
  return {
    capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: false },
    search: vi.fn(async () => ({ hits: [{ reference, excerpt: "A record" }] })),
    get: vi.fn(async () => ({ status: "ok" as const, reference, text: "Record body" })),
    health: vi.fn(async () => ({ status: "ready" as const })),
    close: vi.fn(async () => {}),
  } satisfies MemoryProviderHandle;
}

// A token-authenticated CLI connection: scoped operator, no user profile or run authority.
function cliClient(scopes: string[] = ["operator.read"]): Client {
  return {
    connId: "cli-connection",
    connect: {
      role: "operator",
      scopes,
      client: { id: "cli", version: "test", platform: "node", mode: "cli" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as Client;
}

let provider: ReturnType<typeof createProvider>;
let open: ReturnType<typeof vi.fn<MemoryProviderRuntime["open"]>>;

async function call(
  method: string,
  params: Record<string, unknown>,
  client: Client,
  extra: Partial<Pick<GatewayRequestHandlerOptions, "signal" | "hasCurrentClientAuthority">> = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: `${method}-request`, method, params },
    respond,
    client,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => config,
      logGateway: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
    ...extra,
  });
  return respond;
}

beforeEach(() => {
  config = providerConfig;
  provider = createProvider();
  open = vi.fn<MemoryProviderRuntime["open"]>(async () => ({ provider }));
  const registry = createEmptyPluginRegistry();
  registry.memoryCapabilities.push({
    pluginId: "records",
    capability: { providerRuntime: { open } },
  });
  setActivePluginRegistry(registry);
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("memory provider reads through Gateway dispatch", () => {
  it("serves v2 search, get, and status to a token-authenticated operator.read client", async () => {
    const client = cliClient();
    const search = await call("memory.search", { version: 2, agentId: "main", query: "x" }, client);
    expect(search).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ version: 2, providerId: "records", hits: [expect.anything()] }),
      undefined,
    );
    const get = await call("memory.get", { agentId: "main", reference }, client);
    expect(get).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "ok", text: "Record body" }),
      undefined,
    );
    const status = await call("memory.status", { agentId: "main" }, client);
    expect(status).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ providerId: "records", status: "ready" }),
      undefined,
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          authority: { kind: "operator", scopes: ["operator.read"], connId: "cli-connection" },
        }),
      }),
    );
  });

  it("refuses a client without operator.read before provider admission", async () => {
    const respond = await call(
      "memory.search",
      { version: 2, agentId: "main", query: "x" },
      cliClient([]),
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("operator.read") }),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps agent-tool callers on their run's operator authority", async () => {
    const client = { ...cliClient(), internal: { syntheticClient: true } } as Client;
    const respond = await call("memory.status", { agentId: "main" }, client);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("operator authority") }),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["request abort", "connection close", "client invalidation", "authority loss"] as const)(
    "refuses an operator read before provider I/O after %s during open",
    async (change) => {
      const client = cliClient();
      const request = new AbortController();
      const connection = new AbortController();
      let authorized = true;
      Object.assign(client, { connectionSignal: connection.signal });
      open.mockImplementation(async () => {
        if (change === "request abort") {
          request.abort(new Error("request cancelled"));
        } else if (change === "connection close") {
          connection.abort(new Error("connection closed"));
        } else if (change === "client invalidation") {
          Object.assign(client, { invalidated: true });
        } else {
          authorized = false;
        }
        return { provider };
      });
      const respond = await call(
        "memory.search",
        { version: 2, agentId: "main", query: "x" },
        client,
        {
          signal: request.signal,
          hasCurrentClientAuthority: () => authorized,
        },
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
      expect(provider.search).not.toHaveBeenCalled();
      expect(provider.close).toHaveBeenCalledOnce();
    },
  );
});

describe("unversioned memory.search during the provider-runtime transition", () => {
  it.each([undefined, 1])(
    "directs version %s to v2 when the memory owner registers only a provider runtime",
    async (version) => {
      const respond = await call(
        "memory.search",
        { agentId: "main", query: "x", ...(version === undefined ? {} : { version }) },
        cliClient(),
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message:
            'memory plugin "records" uses the provider runtime; retry memory.search with version: 2',
        }),
      );
      expect(open).not.toHaveBeenCalled();
    },
  );
});

describe("Memory Core legacy owner", () => {
  const sessionHit = (path: string): MemorySearchResult => ({
    path,
    startLine: 1,
    endLine: 1,
    score: 1,
    snippet: path,
    source: "sessions",
  });
  const hits: MemorySearchResult[] = [
    sessionHit("sessions/main/own-session.jsonl"),
    sessionHit("sessions/ops/foreign-session.jsonl"),
    { ...sessionHit("MEMORY.md"), source: "memory" },
  ];
  const manager: RegisteredMemorySearchManager = {
    search: async () => hits,
    readFile: async () => ({ status: "not_found", text: "", path: "MEMORY.md" }),
    status: () => ({ backend: "builtin", provider: "none" }),
    probeEmbeddingAvailability: async () => ({ ok: true }),
    probeVectorAvailability: async () => false,
    close: async () => {},
  };

  beforeEach(async () => {
    // Memory Core's registered runtime owns session-hit authorization, unmodified.
    const { createMemoryRuntime } = await vi.importActual<{
      createMemoryRuntime: (host: {
        runInBackgroundContext: <T>(run: () => T) => T;
      }) => MemoryPluginRuntime;
    }>("../../../extensions/memory-core/runtime-api.js");
    const memoryRuntime = createMemoryRuntime({ runInBackgroundContext: (run) => run() });
    config = {
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      tools: { sessions: { visibility: "agent" } },
    };
    const registry = createEmptyPluginRegistry();
    registry.memoryCapabilities.push({
      pluginId: "memory-core",
      capability: {
        runtime: {
          getMemorySearchManager: async () => ({ manager }),
          resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
          authorizeSearchHits: memoryRuntime.authorizeSearchHits?.bind(memoryRuntime),
        },
      },
    });
    setActivePluginRegistry(registry);
  });

  it("keeps the selected agent's own session hits for an operator v2 search, as v1 returns them", async () => {
    const respond = await call(
      "memory.search",
      { version: 2, agentId: "main", query: "x" },
      cliClient(),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providerId: "memory-core",
        hits: [
          expect.objectContaining({ reference: expect.objectContaining({ id: hits[0]?.path }) }),
          expect.objectContaining({ reference: expect.objectContaining({ id: "MEMORY.md" }) }),
        ],
      }),
      undefined,
    );
  });

  it("keeps the unversioned memory.search response on the legacy manager", async () => {
    const respond = await call("memory.search", { agentId: "main", query: "x" }, cliClient());
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ agentId: "main", provider: "none", results: hits }),
      undefined,
    );
  });
});
