import type { EventEmitter } from "node:events";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import * as stateDatabaseCoordinator from "../infra/state-database-coordinator.js";
import {
  leaseHeartbeatState as state,
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

function failHandleRelease(releaseCause: Error) {
  const acquireHandle = stateDatabaseCoordinator.acquireStateDatabaseHandleLease;
  return vi
    .spyOn(stateDatabaseCoordinator, "acquireStateDatabaseHandleLease")
    .mockImplementation((params) => {
      const handle = acquireHandle(params);
      const release = handle.release.bind(handle);
      handle.release = (options) => {
        release(options);
        throw releaseCause;
      };
      return handle;
    });
}

describe("state lease heartbeat fail idempotency", () => {
  it("calls onLost at most once when the worker errors then exits after becoming ready", async () => {
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
      expiresAt: Date.now() + 60_000,
      onLost,
    });
    const outcome = heartbeat.ready.catch((error: unknown) => error);
    const worker = workers[0];
    try {
      assert(worker, "Expected the heartbeat worker to be constructed");
      Atomics.store(worker.shared, state.status, state.ready);
      worker.emit("message", null);
      const error = await outcome;
      expect(error).toBeUndefined();
      const testError = new Error("test worker error");
      worker.emit("error", testError);
      worker.emit("exit", 1);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(onLost).toHaveBeenCalledWith(testError);
    } finally {
      await heartbeat.stop();
    }
  });

  it("reports a handle release failure once and preserves it through stop", async () => {
    const releaseCause = new Error("test handle release failure");
    const acquireSpy = failHandleRelease(releaseCause);
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
      expiresAt: Date.now() + 60_000,
      onLost,
    });
    const worker = workers[0];
    try {
      assert(worker, "Expected the heartbeat worker to be constructed");
      Atomics.store(worker.shared, state.status, state.ready);
      worker.emit("message", null);
      await heartbeat.ready;
      worker.emit("exit", 1);

      expect(onLost).toHaveBeenCalledTimes(1);
      const releaseError = onLost.mock.calls[0]?.[0];
      expect(releaseError).toEqual(
        new Error("state lease heartbeat handle release failed", { cause: releaseCause }),
      );
      await expect(heartbeat.stop()).rejects.toBe(releaseError);
    } finally {
      acquireSpy.mockRestore();
      await heartbeat.stop().catch(() => {});
    }
  });

  it("preserves the worker error when exit handle release also fails", async () => {
    const acquireSpy = failHandleRelease(new Error("test handle release failure"));
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
      expiresAt: Date.now() + 60_000,
      onLost,
    });
    const worker = workers[0];
    try {
      assert(worker, "Expected the heartbeat worker to be constructed");
      Atomics.store(worker.shared, state.status, state.ready);
      worker.emit("message", null);
      await heartbeat.ready;
      const workerError = new Error("test worker error");
      worker.emit("error", workerError);
      worker.emit("exit", 1);

      expect(onLost).toHaveBeenCalledExactlyOnceWith(workerError);
      await expect(heartbeat.stop()).rejects.toBe(workerError);
    } finally {
      acquireSpy.mockRestore();
      await heartbeat.stop().catch(() => {});
    }
  });
});

describe("state lease heartbeat startup diagnostics", () => {
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
            `state lease heartbeat did not become ready (phase=startup, trigger=${trigger}, status=${status}, elapsedMs=${elapsedMs}, timeoutMs=${Math.min(5_000, remainingMs)})`,
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
});
