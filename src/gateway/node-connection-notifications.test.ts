// Node connection notification routing tests cover active-first delivery and fallback fanout.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  scheduleNodeConnectionNotification,
  startNodeConnectionNotifications,
} from "./node-connection-notifications.js";
import type { NodeSession } from "./node-registry.js";

const PRIMARY_DELAY_MS = 750;
const FALLBACK_DELAY_MS = 5_000;
const disposers: Array<() => void> = [];
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;

function node(
  nodeId: string,
  options: { lastActiveAtMs?: number; presenceUpdatedAtMs?: number } = {},
): NodeSession {
  return {
    nodeId,
    connId: `conn-${nodeId}`,
    pairingIdentity: `identity-${nodeId}`,
    displayName: nodeId,
    platform: "darwin",
    commands: ["system.notify"],
    lastActiveAtMs: options.lastActiveAtMs,
    presenceUpdatedAtMs: options.presenceUpdatedAtMs,
  } as NodeSession;
}

function registry<T extends { listConnected: () => NodeSession[] }>(params: T) {
  const value = params as T & {
    listCurrentConnected?: () => Promise<NodeSession[]>;
    isConnectionCurrentPairingState?: (connId: string) => Promise<boolean>;
  };
  const listCurrentConnected = value.listCurrentConnected ?? (async () => value.listConnected());
  value.listCurrentConnected = listCurrentConnected;
  value.isConnectionCurrentPairingState ??= async (connId) =>
    (await listCurrentConnected()).some((entry) => entry.connId === connId);
  const dispose = startNodeConnectionNotifications(value as never, scheduler);
  disposers.push(dispose);
  return Object.assign(value, { dispose });
}

function schedule(registryValue: object, source: NodeSession): void {
  scheduleNodeConnectionNotification(registryValue as never, source, {
    isFirstConnection: true,
  });
}

beforeEach(() => {
  clock = createGatewaySchedulerClock();
  scheduler = createTestGatewayScheduler(clock.clock);
});

afterEach(async () => {
  for (const dispose of disposers) {
    dispose();
  }
  disposers.length = 0;
  await scheduler.stop();
});

describe("node connection notification routing", () => {
  it("does not alert when a previously connected node reconnects", async () => {
    const source = node("known-node");
    const desk = node("desk");
    const invoke = vi.fn(async () => ({ ok: true }));
    const registryValue = registry({ listConnected: () => [source, desk], invoke });

    scheduleNodeConnectionNotification(registryValue as never, source, {
      isFirstConnection: false,
    });
    await clock.advanceBy(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("delivers once to the most recently active Mac after sleep", async () => {
    const source = node("new-node", { lastActiveAtMs: 50 });
    const desk = node("desk", { lastActiveAtMs: 100 });
    const laptop = node("laptop", { lastActiveAtMs: 200 });
    const invoke = vi.fn(async (_params: { nodeId: string }) => ({ ok: true }));
    const registryValue = registry({ listConnected: () => [source, desk, laptop], invoke });

    schedule(registryValue, source);
    clock.setTime(60_000);
    await clock.wake();
    await clock.wake();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      nodeId: "laptop",
      command: "system.notify",
    });
    await clock.advanceBy(FALLBACK_DELAY_MS);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("waits before falling back to the remaining Macs after primary failure", async () => {
    const source = node("new-node", { lastActiveAtMs: 50 });
    const desk = node("desk", { lastActiveAtMs: 100 });
    const laptop = node("laptop", { lastActiveAtMs: 200 });
    const invoke = vi.fn(async (params: { nodeId: string }) => ({
      ok: params.nodeId !== "laptop",
    }));
    const registryValue = registry({ listConnected: () => [source, desk, laptop], invoke });

    schedule(registryValue, source);
    await clock.advanceBy(PRIMARY_DELAY_MS);
    expect(invoke.mock.calls.map((call) => call[0].nodeId)).toEqual(["laptop"]);

    await clock.advanceBy(FALLBACK_DELAY_MS - 1);
    expect(invoke).toHaveBeenCalledTimes(1);
    await clock.advanceBy(1);
    expect(invoke.mock.calls.map((call) => call[0].nodeId).toSorted()).toEqual([
      "desk",
      "laptop",
      "new-node",
    ]);
  });

  it("delays fanout without activity and keeps later reconnects silent", async () => {
    const source = node("new-node");
    const desk = node("desk");
    const invoke = vi.fn(async (_params: { nodeId: string }) => ({ ok: true }));
    const registryValue = registry({ listConnected: () => [source, desk], invoke });

    schedule(registryValue, source);
    schedule(registryValue, source);
    await clock.advanceBy(PRIMARY_DELAY_MS);
    await clock.advanceBy(FALLBACK_DELAY_MS - 1);
    expect(invoke).not.toHaveBeenCalled();
    await clock.advanceBy(1);
    expect(invoke).toHaveBeenCalledTimes(2);

    scheduleNodeConnectionNotification(registryValue as never, source, {
      isFirstConnection: false,
    });
    await clock.advanceBy(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);
    expect(invoke).toHaveBeenCalledTimes(2);

    await clock.advanceBy(5 * 60_000 + 1);
    scheduleNodeConnectionNotification(registryValue as never, source, {
      isFirstConnection: false,
    });
    await clock.advanceBy(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("drops stale timers and lets a replacement connection take ownership", async () => {
    const oldSource = node("new-node");
    const replacement = { ...node("new-node"), connId: "conn-new-node-replacement" };
    const desk = node("desk", { lastActiveAtMs: 100 });
    let connected = [oldSource, desk];
    const invoke = vi.fn(async (_params: { nodeId: string }) => ({ ok: true }));
    const registryValue = registry({ listConnected: () => connected, invoke });

    schedule(registryValue, oldSource);
    connected = [replacement, desk];
    scheduleNodeConnectionNotification(registryValue as never, replacement, {
      isFirstConnection: false,
    });
    await clock.advanceBy(PRIMARY_DELAY_MS);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ nodeId: "desk" });
  });

  it("drops a source alert when its exact connection is replaced without taking ownership", async () => {
    const oldSource = node("new-node");
    const replacement = {
      ...node("new-node"),
      connId: "conn-new-node-replacement",
      displayName: "Replacement Mac",
    };
    const desk = node("desk", { lastActiveAtMs: 100 });
    let connected = [oldSource, desk];
    const invoke = vi.fn(async (_params: { nodeId: string; params: { body: string } }) => ({
      ok: true,
    }));
    const registryValue = registry({ listConnected: () => connected, invoke });

    schedule(registryValue, oldSource);
    connected = [replacement, desk];
    await clock.advanceBy(PRIMARY_DELAY_MS);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("drops a delayed alert when the source pairing generation is rotated", async () => {
    const source = {
      ...node("new-node"),
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    };
    const desk = node("desk", { lastActiveAtMs: 100 });
    let currentPairingGeneration = "generation-a";
    const invoke = vi.fn(async () => ({ ok: true }));
    const registryValue = registry({
      listConnected: () => [source, desk],
      listCurrentConnected: async () =>
        currentPairingGeneration === source.pairingGeneration ? [source, desk] : [desk],
      isConnectionCurrentPairingState: async (connId: string) =>
        connId === source.connId && currentPairingGeneration === source.pairingGeneration,
      invoke,
    });

    schedule(registryValue, source);
    currentPairingGeneration = "generation-b";
    await clock.advanceBy(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels the first-connection claim when the node is gone at delivery", async () => {
    const source = node("new-node");
    let connected: NodeSession[] = [source];
    const invoke = vi.fn(async () => ({ ok: true }));
    const registryValue = registry({ listConnected: () => connected, invoke });

    schedule(registryValue, source);
    connected = [];
    await clock.advanceBy(PRIMARY_DELAY_MS);

    connected = [source];
    scheduleNodeConnectionNotification(registryValue as never, source, {
      isFirstConnection: false,
    });
    await clock.advanceBy(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not let an in-flight stale attempt cancel its replacement", async () => {
    const oldSource = node("new-node");
    const replacement = { ...node("new-node"), connId: "conn-new-node-replacement" };
    const desk = node("desk", { lastActiveAtMs: 100 });
    let connected = [oldSource, desk];
    const { promise: firstInvoke, resolve: resolveInvoke } = createDeferred<{ ok: boolean }>();
    const invoked = createDeferred();
    const invoke = vi.fn(async () => {
      invoked.resolve();
      return await firstInvoke;
    });
    const registryValue = registry({ listConnected: () => connected, invoke });

    schedule(registryValue, oldSource);
    const firstDelivery = clock.advanceBy(PRIMARY_DELAY_MS);
    await invoked.promise;
    expect(invoke).toHaveBeenCalledTimes(1);

    connected = [replacement, desk];
    scheduleNodeConnectionNotification(registryValue as never, replacement, {
      isFirstConnection: false,
    });
    resolveInvoke?.({ ok: true });
    await firstDelivery;
    await clock.advanceBy(PRIMARY_DELAY_MS);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("cancels staged alerts when disposed", async () => {
    const source = node("new-node");
    const invoke = vi.fn(async () => ({ ok: true }));
    const registryValue = registry({ listConnected: () => [source], invoke });

    schedule(registryValue, source);
    registryValue.dispose();
    schedule(registryValue, source);
    await clock.advanceBy(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not notify after shutdown interrupts the pairing-state read", async () => {
    const source = node("new-node");
    const desk = node("desk", { lastActiveAtMs: 100 });
    const reading = createDeferred();
    const pairing = createDeferred<boolean>();
    const invoke = vi.fn(async () => ({ ok: true }));
    const registryValue = registry({
      listConnected: () => [source, desk],
      isConnectionCurrentPairingState: async () => {
        reading.resolve();
        return await pairing.promise;
      },
      invoke,
    });

    schedule(registryValue, source);
    const delivery = clock.advanceBy(PRIMARY_DELAY_MS);
    await reading.promise;
    scheduler.beginClose();
    pairing.resolve(true);
    await delivery;

    expect(invoke).not.toHaveBeenCalled();
  });

  it("joins an in-flight delivery during shutdown without scheduling its fallback", async () => {
    const source = node("new-node");
    const desk = node("desk", { lastActiveAtMs: 100 });
    const invoked = createDeferred();
    const result = createDeferred<{ ok: boolean }>();
    const invoke = vi.fn(async () => {
      invoked.resolve();
      return await result.promise;
    });
    const registryValue = registry({ listConnected: () => [source, desk], invoke });

    schedule(registryValue, source);
    const delivery = clock.advanceBy(PRIMARY_DELAY_MS);
    await invoked.promise;

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    registryValue.dispose();
    await Promise.resolve();
    expect(stopped).toBe(false);

    result.resolve({ ok: false });
    await Promise.all([delivery, stopping]);
    await clock.advanceBy(FALLBACK_DELAY_MS);

    expect(stopped).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(scheduler.nextWakeAtMs).toBeNull();
  });

  it("retries a primary Mac through its replacement connection", async () => {
    const source = { ...node("new-node", { lastActiveAtMs: 50 }), platform: "linux" };
    const oldDesk = node("desk", { lastActiveAtMs: 100 });
    const newDesk = { ...oldDesk, connId: "conn-desk-replacement" };
    let connected = [source, oldDesk];
    const invoke = vi.fn(async (params: { expectedConnId: string }) => {
      if (params.expectedConnId === oldDesk.connId) {
        connected = [source, newDesk];
        return { ok: false };
      }
      return { ok: true };
    });
    const registryValue = registry({ listConnected: () => connected, invoke });

    schedule(registryValue, source);
    await clock.advanceBy(PRIMARY_DELAY_MS);
    await clock.advanceBy(FALLBACK_DELAY_MS);

    expect(invoke.mock.calls.map((call) => call[0].expectedConnId)).toEqual([
      oldDesk.connId,
      newDesk.connId,
    ]);
  });
});
