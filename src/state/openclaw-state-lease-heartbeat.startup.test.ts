import type { EventEmitter } from "node:events";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
});

function start(
  remainingMs = 120_000,
  renewal?: { leaseMs: number; heartbeatMs: number; renewDuringStartup: () => number },
) {
  const onLost = vi.fn();
  const heartbeat = startOpenClawStateLeaseHeartbeat({
    path: "/synthetic-private-state/lease.sqlite",
    identity: { scope: "test:startup", key: "delayed", owner: "private-owner" },
    leaseMs: 60_000,
    heartbeatMs: 20_000,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + remainingMs,
    ...renewal,
    onLost,
  });
  const outcome = heartbeat.ready.then(
    () => "ready",
    (error: unknown) => error,
  );
  const worker = workers[0];
  assert(worker);
  return { heartbeat, outcome, worker, onLost };
}

describe("state lease heartbeat startup diagnostics", () => {
  it.each(["deadline", "expiry"] as const)("settles delayed startup at %s", async (ending) => {
    const renewDuringStartup = vi.fn(() => Date.now() + 1_000);
    const { heartbeat, outcome, worker, onLost } = start(1_000, {
      leaseMs: 1_000,
      heartbeatMs: 333,
      renewDuringStartup,
    });
    try {
      worker.emit("online");
      await vi.advanceTimersByTimeAsync(38_000);
      expect(onLost).not.toHaveBeenCalled();
      expect(renewDuringStartup).toHaveBeenCalled();
      expect(Atomics.load(worker.shared, state.status)).toBe(state.starting);
      expect(Atomics.load(worker.shared, state.startupPhase)).toBe(
        leaseHeartbeatStartupPhase["entry-not-observed"],
      );
      const expiresAt = Number(Atomics.load(worker.shared, state.expiresAt));
      expect(expiresAt).toBeGreaterThan(Date.now());
      if (ending === "expiry") {
        renewDuringStartup.mockReturnValue(expiresAt);
      }
      const remainingMs =
        ending === "expiry" ? expiresAt - Date.now() : LEASE_HEARTBEAT_START_TIMEOUT_MS - 38_000;
      await vi.advanceTimersByTimeAsync(remainingMs - 1);
      expect(onLost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const elapsedMs = 38_000 + remainingMs;
      const error = await outcome;
      expect(error).toEqual(
        new Error(
          `state lease heartbeat did not become ready (phase=startup, trigger=timeout, status=starting, elapsedMs=${elapsedMs}, timeoutMs=${elapsedMs}, onlineObserved=true, startupPhase=entry-not-observed)`,
        ),
      );
      expect(onLost).toHaveBeenCalledExactlyOnceWith(error);
      expect(Atomics.load(worker.shared, state.status)).toBe(state.lost);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await heartbeat.stop();
    }
  });

  it("reports lost startup without granting readiness", async () => {
    const status = "lost";
    const trigger = "message";
    const remainingMs = 60_000;
    const elapsedMs = 25;
    const online = false;
    const phase = "entry-not-observed";
    const { heartbeat, outcome, worker, onLost } = start(remainingMs);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    try {
      Atomics.store(worker.shared, state.status, state[status]);
      Atomics.store(worker.shared, state.startupPhase, leaseHeartbeatStartupPhase[phase]);
      await vi.advanceTimersByTimeAsync(elapsedMs - 1);
      expect(settled).toBe(false);
      expect(onLost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      worker.emit("message", null);
      const error = await outcome;
      expect(error).toEqual(
        new Error(
          `state lease heartbeat did not become ready (phase=startup, trigger=${trigger}, status=${status}, elapsedMs=${elapsedMs}, timeoutMs=${Math.min(LEASE_HEARTBEAT_START_TIMEOUT_MS, remainingMs)}, onlineObserved=${online}, startupPhase=${phase})`,
        ),
      );
      expect(onLost).toHaveBeenCalledExactlyOnceWith(error);
      expect(Atomics.load(worker.shared, state.status)).toBe(state.lost);
      expect(String(error)).not.toMatch(/synthetic-private-state|test:startup|private-owner/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await heartbeat.stop();
    }
  });
});
