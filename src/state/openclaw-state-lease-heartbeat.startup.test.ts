import type { EventEmitter } from "node:events";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  leaseHeartbeatState as state,
  leaseHeartbeatStartupPhase,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import { startOpenClawStateLeaseHeartbeat } from "./openclaw-state-lease-heartbeat.js";

const { workers } = vi.hoisted(() => ({
  workers: [] as (EventEmitter & { shared: BigInt64Array })[],
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
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

describe("state lease heartbeat startup diagnostics", () => {
  it.each(["ready", "deadline"] as const)(
    "renews a live lease during delayed startup until %s",
    async (ending) => {
      const onLost = vi.fn();
      const heartbeat = startOpenClawStateLeaseHeartbeat({
        path: "/synthetic-private-state/lease.sqlite",
        identity: { scope: "test:startup", key: "delayed", owner: "live-owner" },
        leaseMs: 1_000,
        heartbeatMs: 333,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 1_000,
        renewDuringStartup: () => Date.now() + 1_000,
        onLost,
      });
      const outcome = heartbeat.ready.then(
        () => "ready",
        (error: unknown) => error,
      );
      try {
        // Withhold worker readiness while the live host can still renew the exact owner.
        await vi.advanceTimersByTimeAsync(1_250);
        expect(onLost).not.toHaveBeenCalled();
        if (ending === "ready") {
          const worker = workers[0];
          assert(worker);
          Atomics.store(worker.shared, state.status, state.ready);
          worker.emit("message", null);
          expect(await outcome).toBe("ready");
        } else {
          await vi.advanceTimersByTimeAsync(3_750);
          expect(String(await outcome)).toMatch(/elapsedMs=5000, timeoutMs=5000/);
          expect(onLost).toHaveBeenCalledOnce();
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await heartbeat.stop();
      }
    },
  );

  it.each([
    { status: "starting", trigger: "timeout", remainingMs: 60_000, elapsedMs: 5_000 },
    { status: "lost", trigger: "timeout", remainingMs: 60_000, elapsedMs: 5_000 },
    { status: "lost", trigger: "message", remainingMs: 60_000, elapsedMs: 25 },
    { status: "starting", trigger: "timeout", remainingMs: 750, elapsedMs: 750 },
  ] as const)(
    "reports $status at $trigger after $elapsedMs ms (remaining lease $remainingMs ms)",
    async ({ status, trigger, remainingMs, elapsedMs }) => {
      const onLost = vi.fn();
      const heartbeat = startOpenClawStateLeaseHeartbeat({
        path: "/synthetic-private-state/lease.sqlite",
        identity: {
          scope: "synthetic-private-scope",
          key: "synthetic-private-key",
          owner: "synthetic-owner-token",
        },
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + remainingMs,
        onLost,
      });
      const outcome = heartbeat.ready.catch((error: unknown) => error);
      const worker = workers[0];
      try {
        assert(worker, "Expected the heartbeat worker to be constructed");
        Atomics.store(worker.shared, state.status, state[status]);
        await vi.advanceTimersByTimeAsync(elapsedMs - 1);
        expect(onLost).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        if (trigger === "message") {
          worker.emit("message", null);
        }
        const error = await outcome;
        expect(error).toEqual(
          new Error(
            `state lease heartbeat did not become ready (phase=startup, trigger=${trigger}, status=${status}, elapsedMs=${elapsedMs}, timeoutMs=${Math.min(5_000, remainingMs)}, onlineObserved=false, startupPhase=entry-not-observed)`,
          ),
        );
        expect(onLost).toHaveBeenCalledExactlyOnceWith(error);
        expect(Atomics.load(worker.shared, state.status)).toBe(state.lost);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await heartbeat.stop();
      }
    },
  );

  it.each(Object.entries(leaseHeartbeatStartupPhase))(
    "reports %s without treating startup observations as readiness",
    async (phase, value) => {
      const onLost = vi.fn();
      const heartbeat = startOpenClawStateLeaseHeartbeat({
        path: "/synthetic-private-state/lease.sqlite",
        identity: { scope: "test:startup", key: "phase", owner: "private-owner" },
        leaseMs: 60_000,
        heartbeatMs: 20_000,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        onLost,
      });
      let settled = false;
      const outcome = heartbeat.ready.catch((error: unknown) => {
        settled = true;
        return error;
      });
      try {
        const worker = workers[0];
        assert(worker);
        worker.emit("online");
        Atomics.store(worker.shared, state.startupPhase, value);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(settled).toBe(false);
        expect(onLost).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const error = await outcome;
        expect(error).toEqual(
          new Error(
            `state lease heartbeat did not become ready (phase=startup, trigger=timeout, status=starting, elapsedMs=5000, timeoutMs=5000, onlineObserved=true, startupPhase=${phase})`,
          ),
        );
        expect(onLost).toHaveBeenCalledExactlyOnceWith(error);
        expect(String(error)).not.toMatch(/synthetic-private-state|test:startup|private-owner/);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await heartbeat.stop();
      }
    },
  );

  it("accepts shared readiness without online or message delivery", async () => {
    const onLost = vi.fn();
    const heartbeat = startOpenClawStateLeaseHeartbeat({
      path: "/synthetic-private-state/lease.sqlite",
      identity: { scope: "test:startup", key: "ready", owner: "live-owner" },
      leaseMs: 60_000,
      heartbeatMs: 20_000,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      onLost,
    });
    try {
      const worker = workers[0];
      assert(worker);
      // Even the default diagnostic phase cannot override authoritative readiness.
      Atomics.store(worker.shared, state.status, state.ready);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(heartbeat.ready).resolves.toBeUndefined();
      expect(onLost).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await heartbeat.stop();
    }
  });
});
