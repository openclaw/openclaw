import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startDevicePairSetupMaintenance } from "./device-bootstrap.js";

const owner = vi.hoisted(() => ({
  execute: vi.fn(),
  changes: new Set<(path: string) => void>(),
  lifecycle: new Set<(event: { kind: string }) => void>(),
}));

// mock-isolation: Control worker settlement and receipts without opening a pairing database.
vi.mock("./device-pairing-worker.js", () => ({
  executeDevicePairingMutation: owner.execute,
  onDevicePairSetupChange: (listener: (path: string) => void) => {
    owner.changes.add(listener);
    return () => owner.changes.delete(listener);
  },
}));
// mock-isolation: Use synthetic admission without inspecting the user's state directory.
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({
    admission: { databasePath: "/synthetic/state.sqlite" },
  }),
}));
// mock-isolation: Own lifecycle notifications without registering process-global databases.
vi.mock("../state/openclaw-state-db-cache.js", () => ({
  registerOpenClawStateDatabaseAsyncResource: vi.fn(),
  registerOpenClawStateDatabaseLifecycleListener: (listener: (event: { kind: string }) => void) => {
    owner.lifecycle.add(listener);
    return () => owner.lifecycle.delete(listener);
  },
}));

afterEach(() => {
  owner.execute.mockReset();
});

describe("device setup maintenance deadlines", () => {
  it("parks empty inventory, wakes on a receipt, and prunes overdue work after sleep and restart", async () => {
    const clock = createGatewaySchedulerClock(1_000);
    const scheduler = createTestGatewayScheduler(clock.clock);
    owner.execute.mockResolvedValue({ removed: 0, nextExpiryAtMs: null });
    startDevicePairSetupMaintenance({ scheduler: scheduler.scope(), onError: vi.fn() });
    await clock.wake();
    expect(clock.armedAtMs).toBeNull();
    owner.execute.mockResolvedValueOnce({ removed: 0, nextExpiryAtMs: 5_000 });
    for (const changed of owner.changes) {
      changed("/synthetic/state.sqlite");
    }
    await clock.wake();
    expect(clock.armedAtMs).toBe(5_000);
    await clock.advanceTo(20_000);
    expect(owner.execute).toHaveBeenLastCalledWith(
      { type: "bootstrap.prune", input: { nowMs: 20_000 } },
      expect.anything(),
    );
    expect(clock.armedAtMs).toBeNull();
    await scheduler.stop();

    const restarted = createTestGatewayScheduler(clock.clock);
    startDevicePairSetupMaintenance({ scheduler: restarted.scope(), onError: vi.fn() });
    await clock.wake();
    expect(owner.execute).toHaveBeenCalledTimes(4);
    await restarted.stop();
  });

  it("keeps a receipt arriving during discovery without overlapping reads", async () => {
    const clock = createGatewaySchedulerClock(1_000);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const discovery = createDeferred<{ removed: number; nextExpiryAtMs: number | null }>();
    const entered = createDeferred();
    owner.execute
      .mockImplementationOnce(() => {
        entered.resolve();
        return discovery.promise;
      })
      .mockResolvedValue({ removed: 0, nextExpiryAtMs: 5_000 });
    startDevicePairSetupMaintenance({ scheduler: scheduler.scope(), onError: vi.fn() });
    const first = clock.wake();
    await entered.promise;
    for (const changed of owner.changes) {
      changed("/synthetic/state.sqlite");
    }
    await clock.wake();
    expect(owner.execute).toHaveBeenCalledOnce();
    discovery.resolve({ removed: 0, nextExpiryAtMs: null });
    await first;
    await clock.wake();
    expect(owner.execute).toHaveBeenCalledTimes(2);
    expect(clock.armedAtMs).toBe(5_000);
    await scheduler.stop();
  });
});
