import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemoryProviderHandle } from "../../plugins/memory-provider-types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import { expectRpcError, expectRpcResult } from "./rpc-response.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  capture: vi.fn(),
  legacy: vi.fn(),
  resolveBackend: vi.fn(),
}));
vi.mock("../../plugins/memory-runtime.js", () => ({
  getActiveMemoryProviderCore: mocks.acquire,
  getActiveMemorySearchManagerCore: mocks.legacy,
  resolveActiveMemoryBackendConfig: mocks.resolveBackend,
}));
vi.mock("../operator-run-authority.js", () => ({
  captureGatewayOperatorRunAuthority: mocks.capture,
}));

import { memorySearchHandlers } from "./memory-search.js";

const config: OpenClawConfig = { agents: { entries: { main: {} } } };
const reference = { providerId: "records", id: "claim:42", revision: "r3" };

function operatorClient(): NonNullable<GatewayRequestHandlerOptions["client"]> {
  return {
    connId: "cli-connection",
    connect: {
      role: "operator",
      scopes: ["operator.read"],
      client: { id: "cli", version: "test", platform: "node", mode: "cli" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as NonNullable<GatewayRequestHandlerOptions["client"]>;
}

function syntheticClient(): NonNullable<GatewayRequestHandlerOptions["client"]> {
  return { ...operatorClient(), internal: { syntheticClient: true } } as NonNullable<
    GatewayRequestHandlerOptions["client"]
  >;
}

function request(
  method: string,
  params: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"] = operatorClient(),
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "memory-request", method, params },
    params,
    client,
    respond: vi.fn(),
    context: { getRuntimeConfig: () => config } as GatewayRequestContext,
    isWebchatConnect: () => false,
  };
}

async function invoke(method: string, options: GatewayRequestHandlerOptions): Promise<void> {
  const handler = memorySearchHandlers[method];
  if (!handler) {
    throw new Error(`Missing memory handler: ${method}`);
  }
  await handler(options);
}

function createProvider() {
  return {
    capabilities: {
      sources: ["memory"],
      pagination: true,
      candidates: [],
      projectFilter: false,
    },
    search: vi.fn(async () => ({
      hits: [{ reference, excerpt: "A record, not a workspace file" }],
      coverage: "partial" as const,
      nextCursor: "page2",
    })),
    get: vi.fn(async () => ({ status: "ok" as const, reference, text: "Record body" })),
    health: vi.fn(async () => ({ status: "ready" as const })),
    close: vi.fn(async () => {}),
  } satisfies MemoryProviderHandle;
}

describe("provider-neutral memory RPC", () => {
  let provider: ReturnType<typeof createProvider>;
  let assertCurrent: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBackend.mockReturnValue({ backend: "builtin" });
    assertCurrent = vi.fn();
    release = vi.fn();
    mocks.capture.mockResolvedValue({
      authority: { scopes: ["operator.read"], assertCurrent },
      release,
    });
    provider = createProvider();
    mocks.acquire.mockResolvedValue({ provider, providerId: "records", adapter: "native" });
  });

  it("routes explicit v2 search, record retrieval, and health without the file runtime", async () => {
    const search = request("memory.search", {
      version: 2,
      query: "record",
      agentId: "main",
      sources: ["memory"],
    });
    await invoke("memory.search", search);
    expect(provider.search).toHaveBeenCalledExactlyOnceWith({
      query: "record",
      maxResults: 20,
      minScore: undefined,
      cursor: undefined,
      sources: ["memory"],
    });
    expectRpcResult(search.respond, {
      version: 2,
      agentId: "main",
      providerId: "records",
      hits: [{ reference, excerpt: "A record, not a workspace file" }],
      coverage: "partial",
      nextCursor: "page2",
    });
    const get = request("memory.get", { reference, from: 2, lines: 10 });
    await invoke("memory.get", get);
    expect(provider.get).toHaveBeenCalledWith({ reference, from: 2, lines: 10 });
    expectRpcResult(
      get.respond,
      expect.objectContaining({ status: "ok", reference, text: "Record body" }),
    );
    const health = request("memory.status", {});
    await invoke("memory.status", health);
    expectRpcResult(health.respond, {
      version: 2,
      agentId: "main",
      providerId: "records",
      status: "ready",
    });
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(provider.close).toHaveBeenCalledTimes(3);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          authority: { kind: "operator", scopes: ["operator.read"], connId: "cli-connection" },
        }),
      }),
    );
  });

  it.each([
    ["memory.search", { version: 2, query: "", agentId: "main" }],
    ["memory.search", { version: 2, query: "x", agentId: "unknown" }],
    ["memory.search", { version: 3, query: "x" }],
    ["memory.search", { version: 2, query: "x", sources: "memory" }],
    ["memory.search", { version: 2, query: "x", sources: ["unknown"] }],
    ["memory.search", { version: 2, query: "x", sources: [] }],
    ["memory.get", { reference: { id: "claim:42" } }],
    ["memory.get", { reference, from: -1 }],
  ])("rejects invalid %s input before provider admission", async (method, params) => {
    const options = request(method, params);
    await invoke(method, options);
    expectRpcError(options.respond, { code: "INVALID_REQUEST" });
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it.each(["agent", "ingress"] as const)(
    "does not release a late result after an %s operator authority is revoked",
    async (caller) => {
      const pending = createDeferredCore<{ status: "ready" }>();
      provider.health.mockImplementation(() => pending.promise);
      const client = syntheticClient();
      if (caller === "ingress") {
        delete client.connId;
        const principal = createRemoteControlUiIngressTestContext().resolvePrincipal();
        client.internal = {
          remoteIngressPrincipal: principal,
          operatorRoleActor: principal.operatorRoleActor,
        };
      }
      const options = request("memory.status", {}, client);
      const entered = createDeferredCore();
      mocks.acquire.mockImplementation(async () => {
        entered.resolve();
        return { provider, providerId: "records" };
      });
      const result = invoke("memory.status", options);
      await entered.promise;
      assertCurrent.mockImplementation(() => {
        throw new Error("operator revoked");
      });
      pending.resolve({ status: "ready" });
      await result;
      expectRpcError(options.respond, { message: "operator revoked" });
      expect(provider.close).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["an unauthenticated caller", null],
    ["an agent run without operator authority", "synthetic"],
  ] as const)("refuses %s before provider admission", async (_name, caller) => {
    mocks.capture.mockResolvedValueOnce(undefined);
    const denied = request("memory.status", {}, caller === null ? null : syntheticClient());
    await invoke("memory.status", denied);
    expect(mocks.acquire).not.toHaveBeenCalled();
    expectRpcError(denied.respond, { code: "UNAVAILABLE" });
  });

  it("does not retry a provider denial via legacy", async () => {
    mocks.acquire.mockRejectedValueOnce(new Error("provider denied"));
    const deniedProvider = request("memory.search", { version: 2, query: "record" });
    await invoke("memory.search", deniedProvider);
    expectRpcError(deniedProvider.respond, { message: "provider denied" });
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
});
