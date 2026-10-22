import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

function node(nodeId: string, lastActiveAtMs?: number): NodeSession {
  return {
    nodeId,
    connId: `conn-${nodeId}`,
    pairingIdentity: `identity-${nodeId}`,
    platform: "darwin",
    commands: ["system.notify"],
    lastActiveAtMs,
  } as NodeSession;
}

function schedule(registryValue: object, source: NodeSession, isFirstConnection = true): void {
  scheduleNodeConnectionNotification(registryValue as never, source, { isFirstConnection });
}

function fixture(connected = [node("new-node"), node("desk", 100)]) {
  const state = { connected };
  const invoke = vi.fn(async (_params: { nodeId: string; expectedConnId?: string }) => ({
    ok: true,
  }));
  const registryValue = {
    listCurrentConnected: async () => state.connected,
    isConnectionCurrentPairingState: async (connId: string): Promise<boolean> =>
      (await registryValue.listCurrentConnected()).some((entry) => entry.connId === connId),
    invoke,
  };
  const dispose = startNodeConnectionNotifications(registryValue as never, scheduler);
  disposers.push(dispose);
  return { state, invoke, registryValue, dispose, source: connected[0]! };
}

const activeNodes = () =>
  [50, 100, 200].map((lastActiveAtMs, i) =>
    node(["new-node", "desk", "laptop"][i]!, lastActiveAtMs),
  );

async function beginBlockedDelivery(f: ReturnType<typeof fixture>) {
  const invoked = createDeferred();
  const result = createDeferred<{ ok: boolean }>();
  f.invoke.mockImplementation(async () => {
    invoked.resolve();
    return await result.promise;
  });
  schedule(f.registryValue, f.source);
  const delivery = clock.advanceBy(PRIMARY_DELAY_MS);
  await invoked.promise;
  return { delivery, result };
}

beforeEach(() => {
  clock = createGatewaySchedulerClock();
  scheduler = createTestGatewayScheduler(clock.clock);
});

afterEach(async () => {
  disposers.splice(0).forEach((dispose) => dispose());
  await scheduler.stop();
});

it("delivers once to the most recently active Mac after sleep", async () => {
  const { source, invoke, registryValue } = fixture(activeNodes());

  schedule(registryValue, source);
  clock.setTime(60_000);
  await clock.wake();
  await clock.wake();

  expect(invoke.mock.calls.map(([params]) => params)).toMatchObject([
    { nodeId: "laptop", command: "system.notify" },
  ]);
  await clock.advanceBy(FALLBACK_DELAY_MS);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("waits before falling back to the remaining Macs after primary failure", async () => {
  const { source, invoke, registryValue } = fixture(activeNodes());
  invoke.mockImplementation(async ({ nodeId }) => ({ ok: nodeId !== "laptop" }));

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
  const { source, invoke, registryValue } = fixture([node("new-node"), node("desk")]);

  schedule(registryValue, source);
  schedule(registryValue, source);
  await clock.advanceBy(PRIMARY_DELAY_MS);
  await clock.advanceBy(FALLBACK_DELAY_MS - 1);
  expect(invoke).not.toHaveBeenCalled();
  await clock.advanceBy(1);
  expect(invoke).toHaveBeenCalledTimes(2);

  schedule(registryValue, source, false);
  await clock.advanceBy(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);
  expect(invoke).toHaveBeenCalledTimes(2);

  await clock.advanceBy(5 * 60_000 + 1);
  schedule(registryValue, source, false);
  await clock.advanceBy(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each([true, false])(
  "notifies a replacement only when it takes ownership: %s",
  async (takeOwnership) => {
    const { source, state, invoke, registryValue } = fixture();
    const replacement = {
      ...source,
      connId: "conn-new-node-replacement",
      displayName: "Replacement Mac",
    };

    schedule(registryValue, source);
    state.connected[0] = replacement;
    if (takeOwnership) {
      schedule(registryValue, replacement, false);
    }
    await clock.advanceBy(PRIMARY_DELAY_MS);
    expect(invoke.mock.calls.map(([params]) => params.nodeId)).toEqual(
      takeOwnership ? ["desk"] : [],
    );
  },
);

it("drops a delayed alert when the source pairing generation is rotated", async () => {
  const source = {
    ...node("new-node"),
    pairingIdentity: "identity-a",
    pairingGeneration: "generation-a",
  };
  const desk = node("desk", 100);
  let currentPairingGeneration = "generation-a";
  const { invoke, registryValue } = fixture([source, desk]);
  registryValue.listCurrentConnected = async () =>
    currentPairingGeneration === source.pairingGeneration ? [source, desk] : [desk];
  registryValue.isConnectionCurrentPairingState = async (connId) =>
    connId === source.connId && currentPairingGeneration === source.pairingGeneration;

  schedule(registryValue, source);
  currentPairingGeneration = "generation-b";
  await clock.advanceBy(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);

  expect(invoke).not.toHaveBeenCalled();
});

it("cancels the first-connection claim when the node is gone at delivery", async () => {
  const { source, state, invoke, registryValue } = fixture([node("new-node")]);

  schedule(registryValue, source);
  state.connected = [];
  await clock.advanceBy(PRIMARY_DELAY_MS);

  state.connected = [source];
  schedule(registryValue, source, false);
  await clock.advanceBy(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);
  expect(invoke).not.toHaveBeenCalled();
});

it("does not let an in-flight stale attempt cancel its replacement", async () => {
  const f = fixture();
  const { source, state, invoke, registryValue } = f;
  const replacement = { ...source, connId: "conn-new-node-replacement" };
  const { delivery, result } = await beginBlockedDelivery(f);
  expect(invoke).toHaveBeenCalledTimes(1);

  state.connected[0] = replacement;
  schedule(registryValue, replacement, false);
  result.resolve({ ok: true });
  await delivery;
  await clock.advanceBy(PRIMARY_DELAY_MS);

  expect(invoke).toHaveBeenCalledTimes(2);
});

it("cancels staged alerts when disposed", async () => {
  const { source, invoke, registryValue, dispose } = fixture([node("new-node")]);

  schedule(registryValue, source);
  dispose();
  schedule(registryValue, source);
  await clock.advanceBy(PRIMARY_DELAY_MS + FALLBACK_DELAY_MS);

  expect(invoke).not.toHaveBeenCalled();
});

it("does not notify after shutdown interrupts the pairing-state read", async () => {
  const { source, invoke, registryValue } = fixture();
  const reading = createDeferred();
  const pairing = createDeferred<boolean>();
  registryValue.isConnectionCurrentPairingState = async () => {
    reading.resolve();
    return await pairing.promise;
  };

  schedule(registryValue, source);
  const delivery = clock.advanceBy(PRIMARY_DELAY_MS);
  await reading.promise;
  scheduler.beginClose();
  pairing.resolve(true);
  await delivery;

  expect(invoke).not.toHaveBeenCalled();
});

it("joins an in-flight delivery during shutdown without scheduling its fallback", async () => {
  const f = fixture();
  const { invoke, dispose } = f;
  const { delivery, result } = await beginBlockedDelivery(f);
  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  dispose();
  await Promise.resolve();
  expect(stopped).toBe(false);

  result.resolve({ ok: false });
  await Promise.all([delivery, stopping]);
  await clock.advanceBy(FALLBACK_DELAY_MS);

  expect({ stopped, calls: invoke.mock.calls.length, nextWake: scheduler.nextWakeAtMs }).toEqual({
    stopped: true,
    calls: 1,
    nextWake: null,
  });
});

it("retries a primary Mac through its replacement connection", async () => {
  const oldDesk = node("desk", 100);
  const { source, state, invoke, registryValue } = fixture([
    { ...node("new-node", 50), platform: "linux" },
    oldDesk,
  ]);
  const newDesk = { ...oldDesk, connId: "conn-desk-replacement" };
  invoke.mockImplementation(async (params) => {
    if (params.expectedConnId === oldDesk.connId) {
      state.connected = [source, newDesk];
      return { ok: false };
    }
    return { ok: true };
  });

  schedule(registryValue, source);
  await clock.advanceBy(PRIMARY_DELAY_MS);
  await clock.advanceBy(FALLBACK_DELAY_MS);

  expect(invoke.mock.calls.map((call) => call[0].expectedConnId)).toEqual([
    oldDesk.connId,
    newDesk.connId,
  ]);
});
