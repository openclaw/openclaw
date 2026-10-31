import { describe, expect, it, vi } from "vitest";
import type {
  PortalOpenResult,
  PortalSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-method-policy.js";
import type { GatewayPortalService } from "../portals/portal-service.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { makeClient } from "../server-broadcast.test-helpers.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import { portalHandlers } from "./portals.js";

const publicPortal = {
  id: "p3000",
  title: "App",
  port: 3000,
  listenPort: 43123,
  publicUrl: "http://127.0.0.1:43123/",
  createdAtMs: 1,
};
const portal = {
  ...publicPortal,
  tokenQuery: `openclaw_portal=${"a".repeat(64)}`,
  url: `http://127.0.0.1:43123/?openclaw_portal=${"a".repeat(64)}`,
} satisfies PortalOpenResult;

function createService(overrides: Partial<GatewayPortalService> = {}): GatewayPortalService {
  return {
    list: () => [],
    listWorkerPortals: () => [],
    open: vi.fn(),
    close: vi.fn(),
    closeWorkerPortals: vi.fn(),
    closeAll: vi.fn(),
    ...overrides,
  };
}

function harness(service?: GatewayPortalService, scopes = ["operator.write"]) {
  const broadcast = vi.fn();
  const invoke = async (method: keyof typeof portalHandlers, params: Record<string, unknown>) => {
    const respond = vi.fn();
    await portalHandlers[method]!({
      params,
      respond,
      client: { connect: { scopes } } as never,
      context: { portalService: service, broadcast } as never,
    } as never);
    return respond;
  };
  const expectSuccess = async (method: string, params: Record<string, unknown>, result: unknown) =>
    expect((await invoke(method, params)).mock.calls[0]).toEqual([true, result, undefined]);
  const expectChanged = (portals: PortalSummary[]) =>
    expect(broadcast).toHaveBeenLastCalledWith("portal.changed", { portals }, { dropIfSlow: true });
  return { invoke, expectSuccess, expectChanged };
}

function expectFailure(response: ReturnType<typeof vi.fn>, error: Record<string, unknown>) {
  expect(response).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

describe("portal gateway methods", () => {
  it("registers list and mutations with least-privilege scopes", () => {
    expect(resolveCoreOperatorGatewayMethodScope("portal.list")).toBe("operator.read");
    expect(resolveCoreOperatorGatewayMethodScope("portal.open")).toBe("operator.write");
    expect(resolveCoreOperatorGatewayMethodScope("portal.close")).toBe("operator.write");
  });

  it("round-trips list, open, and idempotent close with replace-set broadcasts", async () => {
    let portals: PortalSummary[] = [];
    const service = createService({
      list: () => portals,
      open: vi.fn(async () => {
        portals = [portal];
        return portal;
      }),
      close: vi.fn(async () => {
        portals = [];
      }),
    });
    const { expectSuccess, expectChanged } = harness(service);
    await expectSuccess("portal.list", {}, { portals: [] });
    await expectSuccess("portal.open", { port: 3000, title: "App" }, portal);
    expect(service.open).toHaveBeenCalledWith({ targetPort: 3000, title: "App" });
    expectChanged([publicPortal]);
    await expectSuccess("portal.close", { id: "missing" }, { closed: true });
    expectChanged([]);
  });

  it("returns portal credentials only to write-capable operators", async () => {
    const service = createService({ list: () => [portal] });

    const list = async (scope: string) =>
      (await harness(service, [scope]).invoke("portal.list", {})).mock.calls[0]?.[1];
    expect(await list("operator.read")).toEqual({ portals: [publicPortal] });
    expect(await list("operator.write")).toEqual({ portals: [portal] });
    expect(await list("operator.admin")).toEqual({ portals: [portal] });
  });

  it("rejects malformed requests before service access and reports absent transports", async () => {
    const service = createService({ list: vi.fn(() => []), listWorkerPortals: vi.fn(() => []) });
    const invalid = await harness(service).invoke("portal.open", { port: 0 });
    expectFailure(invalid, { code: "INVALID_REQUEST" });
    expect(service.open).not.toHaveBeenCalled();

    const unavailable = await harness().invoke("portal.list", {});
    expectFailure(unavailable, { code: "INVALID_REQUEST", message: "portals unavailable" });
  });

  it("returns Error messages without the Error prefix", async () => {
    const service = createService({
      open: vi.fn(async () => {
        throw new Error("portal bind failed");
      }),
    });

    const response = await harness(service).invoke("portal.open", { port: 3000 });
    expectFailure(response, { code: "UNAVAILABLE", message: "portal bind failed" });
  });

  it("delivers portal changes only to read-capable operators", () => {
    const peers = [
      makeClient("pairing", "operator", ["operator.pairing"]),
      makeClient("node", "node", ["operator.read"]),
      makeClient("read", "operator", ["operator.read"]),
      makeClient("write", "operator", ["operator.write"]),
    ];
    const clients = new GatewayClientRegistry(peers.map(({ client }) => client));
    createGatewayBroadcaster({ clients }).broadcast("portal.changed", { portals: [portal] });

    expect(
      Object.fromEntries(peers.map(({ client, socket }) => [client.connId, socket.events])),
    ).toEqual({
      pairing: [],
      node: [],
      read: ["portal.changed"],
      write: ["portal.changed"],
    });
  });
});
