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

vi.mock("../infra/sqlite-worker-identity.js", () => ({
  readDatabasePathIdentitySync: (canonicalPath: string) => ({ key: "file:12:34", canonicalPath }),
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
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

describe("state lease heartbeat startup diagnostics", () => {
  it.each(["ready", "deadline", "expiry"] as const)(
    "renews a live lease during delayed startup until %s",
    async (ending) => {
      const onLost = vi.fn();
      const renewDuringStartup = vi.fn(() => Date.now() + 1_000);
      const heartbeat = startOpenClawStateLeaseHeartbeat({
        path: "/synthetic-private-state/lease.sqlite",
        identity: { scope: "test:startup", key: "delayed", owner: "live-owner" },
        leaseMs: 1_000,
        heartbeatMs: 333,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 1_000,
        renewDuringStartup,
        onLost,
      });
      const outcome = heartbeat.ready.then(
        () => "ready",
        (error: unknown) => error,
      );
      try {
        const worker = workers[0];
        assert(worker);
        worker.emit("online");
        // Worker online can precede module entry by seconds on a loaded host.
        await vi.advanceTimersByTimeAsync(38_000);
        expect(onLost).not.toHaveBeenCalled();
        expect(renewDuringStartup).toHaveBeenCalled();
        expect(Atomics.load(worker.shared, state.status)).toBe(state.starting);
        expect(Atomics.load(worker.shared, state.startupPhase)).toBe(
          leaseHeartbeatStartupPhase["entry-not-observed"],
        );
        const expiresAt = Number(Atomics.load(worker.shared, state.expiresAt));
        expect(expiresAt).toBeGreaterThan(Date.now());
        if (ending === "ready") {
          Atomics.store(
            worker.shared,
            state.startupPhase,
            leaseHeartbeatStartupPhase["body-entry"],
          );
          Atomics.store(worker.shared, state.status, state.ready);
          worker.emit("message", null);
          expect(await outcome).toBe("ready");
        } else {
          if (ending === "expiry") {
            renewDuringStartup.mockReturnValue(expiresAt);
          }
          const remainingMs =
            ending === "expiry"
              ? expiresAt - Date.now()
              : LEASE_HEARTBEAT_START_TIMEOUT_MS - 38_000;
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
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await heartbeat.stop();
      }
    },
  );

  it.each([
    {
      status: "starting",
      trigger: "timeout",
      remainingMs: 120_000,
      elapsedMs: LEASE_HEARTBEAT_START_TIMEOUT_MS,
    },
    {
      status: "lost",
      trigger: "timeout",
      remainingMs: 120_000,
      elapsedMs: LEASE_HEARTBEAT_START_TIMEOUT_MS,
    },
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
            `state lease heartbeat did not become ready (phase=startup, trigger=${trigger}, status=${status}, elapsedMs=${elapsedMs}, timeoutMs=${Math.min(LEASE_HEARTBEAT_START_TIMEOUT_MS, remainingMs)}, onlineObserved=false, startupPhase=entry-not-observed)`,
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
        expiresAt: Date.now() + 120_000,
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
        await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_START_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        expect(onLost).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const error = await outcome;
        expect(error).toEqual(
          new Error(
            `state lease heartbeat did not become ready (phase=startup, trigger=timeout, status=starting, elapsedMs=${LEASE_HEARTBEAT_START_TIMEOUT_MS}, timeoutMs=${LEASE_HEARTBEAT_START_TIMEOUT_MS}, onlineObserved=true, startupPhase=${phase})`,
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
      expiresAt: Date.now() + 120_000,
      onLost,
    });
    try {
      const worker = workers[0];
      assert(worker);
      // Even the default diagnostic phase cannot override authoritative readiness.
      Atomics.store(worker.shared, state.status, state.ready);
      await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_START_TIMEOUT_MS);
      await expect(heartbeat.ready).resolves.toBeUndefined();
      expect(onLost).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await heartbeat.stop();
    }
  });
});
