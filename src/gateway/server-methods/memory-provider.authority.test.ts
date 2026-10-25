import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemorySearchResult } from "../../memory-host-sdk/host/types.js";
import type {
  MemoryPluginRuntime,
  MemoryProviderRuntime,
  RegisteredMemorySearchManager,
} from "../../plugins/registry-contribution-types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import * as profiles from "../../state/user-profile-list.js";
import { resolveBundledPluginPublicModulePath } from "../../test-utils/bundled-plugin-public-surface.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createMemoryOperatorClient as cliClient,
  createMemoryProvider,
} from "./memory-provider.test-support.js";
import { expectRpcError, expectRpcResult } from "./rpc-response.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type Client = NonNullable<Parameters<typeof handleGatewayRequest>[0]["client"]>;

const providerConfig: OpenClawConfig = { agents: { entries: { main: {} } } };
let config = providerConfig;
const reference = { providerId: "records", id: "claim:42", revision: "r3" };
const searchPage = {
  hits: [{ reference, excerpt: "A record, not a workspace file" }],
  coverage: "partial" as const,
  nextCursor: "page2",
};

let provider: ReturnType<typeof createMemoryProvider>;
let open: ReturnType<typeof vi.fn<MemoryProviderRuntime["open"]>>;

async function call(
  method: string,
  params: Record<string, unknown>,
  client: Client = cliClient(),
  extra: Partial<Pick<GatewayRequestHandlerOptions, "signal" | "hasCurrentClientAuthority">> = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: `${method}-request`, method, params: { agentId: "main", ...params } },
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

const searchParams = { version: 2, query: "x" };

let sharedGateway = false;

beforeEach(() => {
  sharedGateway = false;
  vi.spyOn(profiles, "hasMultipleResidentSessionSharingIdentities").mockImplementation(
    () => sharedGateway,
  );
  config = providerConfig;
  provider = createMemoryProvider(reference, searchPage, true);
  open = vi.fn<MemoryProviderRuntime["open"]>(async () => ({ provider }));
  const registry = createEmptyPluginRegistry();
  registry.memoryCapabilities.push({
    pluginId: "records",
    capability: { providerRuntime: { open } },
  });
  setActivePluginRegistry(registry);
});

afterEach(resetPluginRuntimeStateForTest);

describe("memory provider reads through Gateway dispatch", () => {
  it("serves v2 search, get, and status to a token-authenticated operator.read client", async () => {
    const client = cliClient();
    const search = await call("memory.search", { ...searchParams, sources: ["memory"] }, client);
    expect(provider.search).toHaveBeenCalledExactlyOnceWith({
      query: "x",
      maxResults: 20,
      minScore: undefined,
      cursor: undefined,
      sources: ["memory"],
    });
    expectRpcResult(search, { version: 2, agentId: "main", providerId: "records", ...searchPage });
    const get = await call("memory.get", { reference, from: 2, lines: 10 }, client);
    expect(provider.get).toHaveBeenCalledWith({ reference, from: 2, lines: 10 });
    expectRpcResult(get, expect.objectContaining({ status: "ok", reference, text: "Record body" }));
    const status = await call("memory.status", {}, client);
    expectRpcResult(status, {
      version: 2,
      agentId: "main",
      providerId: "records",
      status: "ready",
    });
    expect(provider.close).toHaveBeenCalledTimes(3);
    expect(open.mock.calls[0]?.[0].context.authority).toEqual({
      kind: "operator",
      scopes: ["operator.read"],
      connId: "cli-connection",
    });
  });

  it("requires an administrator for content reads on a shared Gateway", async () => {
    sharedGateway = true;
    expectRpcError(await call("memory.search", searchParams), {
      message: expect.stringContaining("requires an administrator"),
    });
    expectRpcError(await call("memory.get", { reference }), {
      message: expect.stringContaining("requires an administrator"),
    });
    expect(open).not.toHaveBeenCalled();
    expectRpcResult(await call("memory.status", {}), expect.objectContaining({ status: "ready" }));
    const admin = await call("memory.search", searchParams, cliClient(["operator.admin"]));
    expectRpcResult(admin, expect.objectContaining({ agentId: "main" }));
  });

  it("refuses a content read before provider I/O when the Gateway becomes shared during open", async () => {
    open.mockImplementation(async (input) => {
      sharedGateway = true;
      input.context.assertCurrent();
      return { provider };
    });
    expectRpcError(await call("memory.search", searchParams), {
      message: expect.stringContaining("requires an administrator"),
    });
    expect(provider.search).not.toHaveBeenCalled();
  });

  it.each([
    { method: "memory.search", client: () => cliClient([]), message: "operator.read" },
    {
      method: "memory.status",
      client: () => ({ ...cliClient(), internal: { syntheticClient: true } }) as Client,
      message: "operator authority",
    },
  ])("refuses $method without $message", async ({ method, client, message }) => {
    expectRpcError(await call(method, method === "memory.search" ? searchParams : {}, client()), {
      message: expect.stringContaining(message),
    });
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
      const respond = await call("memory.search", searchParams, client, {
        signal: request.signal,
        hasCurrentClientAuthority: () => authorized,
      });
      expectRpcError(respond, { code: "UNAVAILABLE" });
      expect(provider.search).not.toHaveBeenCalled();
      expect(provider.close).toHaveBeenCalledOnce();
    },
  );
});

it.each([{}, { version: 1 }])(
  "directs %j to v2 when the memory owner registers only a provider runtime",
  async (version) => {
    const respond = await call("memory.search", { query: "x", ...version });
    expectRpcError(respond, {
      code: "INVALID_REQUEST",
      message:
        'memory plugin "records" uses the provider runtime; retry memory.search with version: 2',
    });
    expect(open).not.toHaveBeenCalled();
  },
);

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
    const source = resolveBundledPluginPublicModulePath({
      pluginId: "memory-core",
      artifactBasename: "index.js",
    });
    registry.plugins.push(
      createPluginRecord({
        id: "memory-core",
        origin: "bundled",
        rootDir: dirname(source),
        source,
      }),
    );
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
    expectRpcResult(
      await call("memory.search", searchParams),
      expect.objectContaining({
        providerId: "memory-core",
        hits: [
          expect.objectContaining({ reference: expect.objectContaining({ id: hits[0]?.path }) }),
          expect.objectContaining({ reference: expect.objectContaining({ id: "MEMORY.md" }) }),
        ],
      }),
    );
  });

  it("keeps the unversioned memory.search response on the legacy manager", async () => {
    expectRpcResult(
      await call("memory.search", { query: "x" }),
      expect.objectContaining({ agentId: "main", provider: "none", results: hits }),
    );
  });
});
