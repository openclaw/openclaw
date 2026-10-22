import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import {
  createMemoryOperatorClient as operatorClient,
  createMemoryProvider,
} from "./memory-provider.test-support.js";
import { expectRpcError } from "./rpc-response.test-support.js";
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

function syntheticClient(): NonNullable<GatewayRequestHandlerOptions["client"]> {
  return { ...operatorClient(), internal: { syntheticClient: true } } as NonNullable<
    GatewayRequestHandlerOptions["client"]
  >;
}

async function invoke(
  method: string,
  params: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"] = operatorClient(),
) {
  const respond = vi.fn();
  await memorySearchHandlers[method]!({
    req: { type: "req", id: "memory-request", method, params },
    params,
    client,
    respond,
    context: { getRuntimeConfig: () => config } as GatewayRequestContext,
    isWebchatConnect: () => false,
  });
  return respond;
}

let provider: ReturnType<typeof createMemoryProvider>;
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
  provider = createMemoryProvider(reference);
  mocks.acquire.mockResolvedValue({ provider, providerId: "records", adapter: "native" });
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
  expectRpcError(await invoke(method, params), { code: "INVALID_REQUEST" });
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
    const entered = createDeferredCore();
    mocks.acquire.mockImplementation(async () => {
      entered.resolve();
      return { provider, providerId: "records" };
    });
    const result = invoke("memory.status", {}, client);
    await entered.promise;
    assertCurrent.mockImplementation(() => {
      throw new Error("operator revoked");
    });
    pending.resolve({ status: "ready" });
    expectRpcError(await result, { message: "operator revoked" });
    expect(provider.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  },
);

it.each([
  ["an unauthenticated caller", null],
  ["an agent run without operator authority", "synthetic"],
] as const)("refuses %s before provider admission", async (_name, caller) => {
  mocks.capture.mockResolvedValueOnce(undefined);
  const denied = await invoke("memory.status", {}, caller === null ? null : syntheticClient());
  expect(mocks.acquire).not.toHaveBeenCalled();
  expectRpcError(denied, { code: "UNAVAILABLE" });
});

it("does not retry a provider denial via legacy", async () => {
  mocks.acquire.mockRejectedValueOnce(new Error("provider denied"));
  const deniedProvider = await invoke("memory.search", { version: 2, query: "record" });
  expectRpcError(deniedProvider, { message: "provider denied" });
  expect(mocks.legacy).not.toHaveBeenCalled();
});
