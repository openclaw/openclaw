import type { EventEmitter } from "node:events";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import {
  leaseHeartbeatState as state,
  leaseHeartbeatStartupPhase,
  LEASE_HEARTBEAT_START_TIMEOUT_MS,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import { startOpenClawStateLeaseHeartbeat } from "./openclaw-state-lease-heartbeat.js";

const { workers } = vi.hoisted(() => ({
  workers: [] as (EventEmitter & { shared: BigInt64Array })[],
}));

vi.mock("../infra/sqlite-worker-identity.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/sqlite-worker-identity.js")>(
    "../infra/sqlite-worker-identity.js",
  )),
  readDatabasePathIdentitySync: (canonicalPath: string) => ({ key: "file:12:34", canonicalPath }),
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  return {
    ...(await importOriginal<typeof import("node:worker_threads")>()),
    isMainThread: true,
    Worker: class extends EventEmitter {
      shared: BigInt64Array;
      stdout = { resume() {} };
      stderr = { resume() {} };

      constructor(_url: URL, options: { workerData: LeaseHeartbeatWorkerData }) {
        super();
        this.shared = new BigInt64Array(options.workerData.shared);
        workers.push(this);
      }

      async terminate() {
        this.emit("exit", 0);
        return 0;
      }
    },
  };
});

beforeEach(() => {
  workers.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});

afterEach(() => vi.useRealTimers());

it.each(["deadline", "expiry", "lost"] as const)("fails startup at %s", async (ending) => {
  const delayed = ending !== "lost";
  const onLost = vi.fn();
  const renewDuringStartup = vi.fn(() => Date.now() + 1_000);
  const heartbeat = startOpenClawStateLeaseHeartbeat({
    path: "/synthetic-private-state/lease.sqlite",
    identity: { scope: "test:startup", key: "delayed", owner: "private-owner" },
    leaseMs: delayed ? 1_000 : 60_000,
    heartbeatMs: delayed ? 333 : 20_000,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + (delayed ? 1_000 : 60_000),
    renewDuringStartup: delayed ? renewDuringStartup : undefined,
    onLost,
  });
  const settled = vi.fn();
  const outcome = heartbeat.ready.catch((error: unknown) => error);
  void outcome.then(settled);
  const worker = workers[0];
  assert(worker);
  const read = (index: number) => Atomics.load(worker.shared, index);
  const initialPhase = leaseHeartbeatStartupPhase["entry-not-observed"];
  let elapsedMs = 25;
  try {
    if (delayed) {
      worker.emit("online");
      await vi.advanceTimersByTimeAsync(38_000);
      expect(onLost).not.toHaveBeenCalled();
      expect(renewDuringStartup).toHaveBeenCalled();
      expect(read(state.status)).toBe(state.starting);
      expect(read(state.startupPhase)).toBe(initialPhase);
      const expiresAt = Number(read(state.expiresAt));
      expect(expiresAt).toBeGreaterThan(Date.now());
      if (ending === "expiry") {
        renewDuringStartup.mockReturnValue(expiresAt);
      }
      const remainingMs =
        ending === "expiry" ? expiresAt - Date.now() : LEASE_HEARTBEAT_START_TIMEOUT_MS - 38_000;
      await vi.advanceTimersByTimeAsync(remainingMs - 1);
      expect(onLost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      elapsedMs = 38_000 + remainingMs;
    } else {
      Atomics.store(worker.shared, state.status, state.lost);
      Atomics.store(worker.shared, state.startupPhase, initialPhase);
      await vi.advanceTimersByTimeAsync(24);
      expect(settled).not.toHaveBeenCalled();
      expect(onLost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      worker.emit("message", null);
    }
    const error = await outcome;
    const trigger = delayed ? "timeout" : "message";
    const status = delayed ? "starting" : "lost";
    const timeoutMs = delayed ? elapsedMs : Math.min(LEASE_HEARTBEAT_START_TIMEOUT_MS, 60_000);
    expect(error).toEqual(
      new Error(
        `state lease heartbeat did not become ready (phase=startup, trigger=${trigger}, status=${status}, elapsedMs=${elapsedMs}, timeoutMs=${timeoutMs}, onlineObserved=${delayed}, startupPhase=entry-not-observed)`,
      ),
    );
    expect(onLost).toHaveBeenCalledExactlyOnceWith(error);
    expect(read(state.status)).toBe(state.lost);
    expect(vi.getTimerCount()).toBe(0);
    expect(String(error)).not.toMatch(/synthetic-private-state|test:startup|private-owner/);
  } finally {
    await heartbeat.stop();
  }
});
