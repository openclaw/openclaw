import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { createGatewayNodeSessionRuntime } from "../server-node-session-runtime.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { nodeEventHandlers } from "./nodes.event.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const { recordHostStatsMock } = vi.hoisted(() => ({ recordHostStatsMock: vi.fn() }));
vi.mock("../../infra/device-pairing-node.js", () => ({
  recordPairedNodeHostStats: recordHostStatsMock,
}));

describe("node host stats receipt", () => {
  it.each([true, false])(
    "keeps the event result independent of persistence when the registry accepts=%s",
    async (accepted) => {
      const stats = { cpuCount: 2, memoryTotalBytes: 4096, memoryFreeBytes: 1024 };
      const hostStats = { ...stats, updatedAtMs: 1_250 };
      const persistence = createDeferred<boolean>();
      recordHostStatsMock.mockReset().mockReturnValue(persistence.promise);
      const session = { nodeId: "node-1", connId: "conn-1", pairingGeneration: "generation-1" };
      const warn = vi.fn();
      const broadcast = vi.fn();
      const updateHostStats = vi.fn(() => (accepted ? hostStats : null));
      const params = { event: "node.host.stats", payload: stats };
      const respond = vi.fn();
      await nodeEventHandlers["node.event"]!({
        req: { type: "req", id: "stats", method: "node.event", params },
        params,
        client: {
          connId: session.connId,
          connect: { device: { id: session.nodeId } },
        } as GatewayRequestHandlerOptions["client"],
        isWebchatConnect: () => false,
        respond,
        context: {
          nodeRegistry: {
            get: () => session,
            getForPairingGeneration: () => session,
            isConnectionCurrentPairingState: async () => true,
            updateHostStats,
          },
          broadcast,
          logGateway: { warn },
        } as unknown as GatewayRequestHandlerOptions["context"],
      });

      expect(updateHostStats).toHaveBeenCalledWith({ nodeId: "node-1", connId: "conn-1", stats });
      const result = [
        true,
        {
          ok: true,
          event: "node.host.stats",
          handled: accepted,
          reason: accepted ? "updated" : "stale_connection",
        },
        undefined,
      ];
      // The RPC has already completed while its store write is still pending.
      expect(respond.mock.calls).toEqual([result]);
      if (accepted) {
        expect(recordHostStatsMock).toHaveBeenCalledExactlyOnceWith({
          nodeId: session.nodeId,
          hostStats,
          expectedPairingGeneration: { nodeId: session.nodeId, key: session.pairingGeneration },
        });
        expect(broadcast).toHaveBeenCalledWith(
          "node.hostStats",
          { nodeId: session.nodeId, hostStats },
          { dropIfSlow: true },
        );
        persistence.reject(new Error("stats store unavailable"));
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            "failed to persist node host stats for node-1: stats store unavailable",
          ),
        );
        expect(respond.mock.calls).toEqual([result]);
      } else {
        persistence.resolve(false);
        expect(recordHostStatsMock).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );
});

function createDesktopEventHarness() {
  const binding = { identity: "identity-1", generation: "generation-1" };
  const resolvePairing = vi.fn(async () => binding);
  const broadcast = vi.fn();
  const runtime = createGatewayNodeSessionRuntime({
    broadcast,
    resolveCurrentPairingState: resolvePairing,
    isPairingStateCurrent: () => true,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
  });
  const register = (connId: string, nodeId = "node-1") => {
    const client = {
      connId,
      usesSharedGatewayAuth: false,
      socket: { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() },
      connect: {
        role: "node",
        scopes: [],
        device: { id: nodeId },
        client: { id: "openclaw-macos", platform: "darwin", mode: "node", version: "1.0.0" },
        caps: [],
        commands: [],
      },
    } as unknown as GatewayWsClient;
    runtime.nodeRegistry.register(client, {
      pairingIdentity: binding.identity,
      pairingGeneration: binding.generation,
    });
    return client;
  };
  const send = async (client: GatewayWsClient, payload: unknown) => {
    const params = { event: "node.desktop.availability", payload };
    const respond = vi.fn();
    await nodeEventHandlers["node.event"]!({
      req: { type: "req", id: "desktop-state", method: "node.event", params },
      params,
      client,
      respond,
      isWebchatConnect: () => false,
      context: {
        ...runtime,
        broadcast,
        logGateway: { warn: vi.fn() },
      } as unknown as GatewayRequestHandlerOptions["context"],
    });
    return respond;
  };
  const changes = () =>
    broadcast.mock.calls
      .filter(([event]) => event === "node.runnerInventory.changed")
      .map(([, payload]) => payload);
  return { ...runtime, binding, resolvePairing, register, send, changes };
}

describe("registered node desktop availability events", () => {
  it("invalidates only the reporting node's inventory on state changes and connection retirement", async () => {
    const h = createDesktopEventHarness();
    const first = h.register("conn-first");
    h.register("conn-other", "node-other");
    for (const state of ["locked", "unlocked", "unknown"] as const) {
      const respond = await h.send(first, { state });
      expect(respond).toHaveBeenCalledWith(
        true,
        { ok: true, event: "node.desktop.availability", handled: true, reason: "updated" },
        undefined,
      );
      expect(h.nodeRegistry.get("node-1")).toMatchObject({ desktopAvailability: { state } });
      expect(h.nodeRegistry.get("node-other")).not.toHaveProperty("desktopAvailability");
    }
    const unchanged = await h.send(first, { state: "unknown" });
    expect(unchanged.mock.calls[0]?.[1]).toMatchObject({ handled: true, reason: "unchanged" });
    expect(h.changes()).toEqual([{ nodeId: "node-1" }, { nodeId: "node-1" }, { nodeId: "node-1" }]);

    const replacement = h.register("conn-replacement");
    expect(h.nodeRegistry.get("node-1")).not.toHaveProperty("desktopAvailability");
    expect(h.changes()).toHaveLength(4);
    const retiredCount = h.changes().length;
    expect(h.changes().at(-1)).toEqual({ nodeId: "node-1" });
    const stale = await h.send(first, { state: "locked" });
    expect(stale.mock.calls[0]?.[0]).toBe(false);
    expect(h.nodeRegistry.unregister(first.connId)).toBeNull();
    expect(h.changes()).toHaveLength(retiredCount);
    await h.send(replacement, { state: "unlocked" });
    expect(h.changes()).toHaveLength(5);
    expect(h.nodeRegistry.unregister(replacement.connId)).toBe("node-1");
    expect(h.nodeRegistry.get("node-1")).toBeUndefined();
    expect(h.changes()).toHaveLength(6);
    expect(h.changes().at(-1)).toEqual({ nodeId: "node-1" });
    h.nodeRegistry.unregister("conn-other");
  });

  it("rejects malformed states and attempts to supply another node identity", async () => {
    const h = createDesktopEventHarness();
    const client = h.register("conn-1");
    for (const payload of [null, [], {}, { state: "idle" }, { state: "locked", nodeId: "other" }]) {
      const respond = await h.send(client, payload);
      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        handled: false,
        reason: "invalid_payload",
      });
    }
    expect(h.nodeRegistry.get("node-1")).not.toHaveProperty("desktopAvailability");
    expect(h.changes()).toEqual([]);
    h.nodeRegistry.unregister(client.connId);
  });

  it("rejects an event whose connection is replaced while pairing validation is pending", async () => {
    const h = createDesktopEventHarness();
    const client = h.register("conn-first");
    const pending = createDeferred<typeof h.binding>();
    h.resolvePairing.mockReturnValueOnce(pending.promise);
    const receipt = h.send(client, { state: "locked" });
    await vi.waitFor(() => expect(h.resolvePairing).toHaveBeenCalledOnce());
    const replacement = h.register("conn-replacement");
    pending.resolve(h.binding);
    expect((await receipt).mock.calls[0]?.[0]).toBe(false);
    expect(h.nodeRegistry.get("node-1")).not.toHaveProperty("desktopAvailability");
    expect(h.changes()).toEqual([]);
    await h.send(replacement, { state: "unlocked" });
    expect(h.changes()).toHaveLength(1);
    h.nodeRegistry.invalidateConnectionForPairingChange(replacement.connId);
    expect(h.changes()).toHaveLength(2);
    expect(h.changes().at(-1)).toEqual({ nodeId: "node-1" });
    expect((await h.send(replacement, { state: "locked" })).mock.calls[0]?.[0]).toBe(false);
    h.nodeRegistry.unregister(replacement.connId);
  });

  it("rejects a late event while the closed transport is retained for lifecycle draining", async () => {
    const h = createDesktopEventHarness();
    const client = h.register("conn-closing");
    const pending = createDeferred<typeof h.binding>();
    h.resolvePairing.mockReturnValueOnce(pending.promise);
    const receipt = h.send(client, { state: "locked" });
    await vi.waitFor(() => expect(h.resolvePairing).toHaveBeenCalledOnce());
    Object.defineProperty(client.socket, "readyState", { value: 3 });
    pending.resolve(h.binding);
    expect((await receipt).mock.calls[0]?.[1]).toMatchObject({
      handled: false,
      reason: "stale_connection",
    });
    expect(h.nodeRegistry.get("node-1")).not.toHaveProperty("desktopAvailability");
    expect(h.changes()).toEqual([]);
    h.nodeRegistry.unregister(client.connId);
  });
});
