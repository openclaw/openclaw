import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LeaseHeartbeatWorkerData } from "./openclaw-state-lease-heartbeat-shared.js";

const fixture = vi.hoisted(() => ({
  worker: undefined as EventEmitter | undefined,
  data: undefined as LeaseHeartbeatWorkerData | undefined,
  renew: vi.fn<() => number | undefined>(),
  readExpiry: vi.fn<() => number | undefined>(),
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    get workerData() {
      return fixture.data;
    },
    parentPort: {
      on() {},
      postMessage: (message: unknown) => fixture.worker?.emit("message", structuredClone(message)),
      close: () => queueMicrotask(() => fixture.worker?.emit("exit", 0)),
    },
    Worker: class extends EventEmitter {
      stdout = { resume() {} };
      stderr = { resume() {} };
      constructor(_url: URL, options: { workerData: LeaseHeartbeatWorkerData }) {
        super();
        fixture.data = options.workerData;
        fixture.worker = this;
      }
      async terminate() {
        this.emit("exit", 0);
        return 0;
      }
    },
  };
});
vi.mock("../infra/state-database-coordinator.js", () => ({
  StateDatabaseCoordinatorContentionError: class extends Error {},
  acquireStateDatabaseCoordinator: () => ({ release() {} }),
  acquireStateDatabaseHandleLease: () => ({ release() {} }),
  retainHeldStateDatabaseCoordinator: () => undefined,
}));
vi.mock("../infra/sqlite-coordinator.js", () => ({
  runWithSqliteCoordinator: (_handle: unknown, _label: string, run: () => unknown) => run(),
}));
vi.mock("../infra/sqlite-busy-timeout.js", () => ({
  runWithSqliteBusyTimeout: (_db: unknown, _ms: number, run: () => unknown) => run(),
}));
vi.mock("../infra/sqlite-transaction-core.js", () => ({
  runSqliteTransactionSync: (_db: unknown, run: () => unknown) => run(),
}));
vi.mock("./openclaw-state-db-handle.js", () => ({
  openTrackedStateDatabase: () => ({}),
  closeTrackedStateDatabase() {},
}));
vi.mock("./openclaw-state-lease-store.js", () => ({
  renewOpenClawStateLeaseInTransaction: fixture.renew,
  readOpenClawStateLeaseExpiry: fixture.readExpiry,
}));

const acquiredAt = 1_800_000_000_000;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(acquiredAt + 100);
  fixture.renew.mockReset().mockImplementation(() => Date.now() + 60_000);
  fixture.readExpiry.mockReset().mockReturnValue(acquiredAt + 60_000);
});
afterEach(() => vi.useRealTimers());

async function start() {
  const { startOpenClawStateLeaseHeartbeat } = await import("./openclaw-state-lease-heartbeat.js");
  const onLost = vi.fn();
  const heartbeat = startOpenClawStateLeaseHeartbeat({
    path: "/synthetic-state/lease.sqlite",
    identity: { scope: "test:diagnostics", key: "lease", owner: "owner" },
    leaseMs: 60_000,
    heartbeatMs: 20_000,
    acquiredAt,
    expiresAt: acquiredAt + 60_000,
    onLost,
  });
  const outcome = heartbeat.ready.catch((error: unknown) => error);
  await import("./openclaw-state-lease-heartbeat.worker.js");
  await vi.advanceTimersByTimeAsync(0);
  return { heartbeat, outcome, onLost };
}

it.each([false, true])(
  "retains the fatal renewal cause after prior success=%s",
  async (renewed) => {
    const failure = Object.assign(new Error("synthetic disk I/O error"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 266,
    });
    fixture.renew.mockImplementation(() => {
      throw failure;
    });
    if (renewed) {
      fixture.renew.mockImplementationOnce(() => Date.now() + 60_000);
    }
    const { heartbeat, outcome, onLost } = await start();
    try {
      if (renewed) {
        await expect(outcome).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(20_000);
      }
      const error: unknown = onLost.mock.calls[0]?.[0];
      expect(error).toMatchObject({
        cause: {
          name: "Error",
          message: failure.message,
          code: failure.code,
          errcode: 266,
          attempt: renewed ? 2 : 1,
          elapsedMs: renewed ? 20_100 : 100,
        },
      });
      expect(String(error)).toContain("state lease heartbeat exited");
      expect(String(error)).toContain("Error: synthetic disk I/O error");
      expect(String(error)).toContain("code=ERR_SQLITE_ERROR, errcode=266");
      expect(String(error)).toContain(`acquiredAt=${acquiredAt}`);
      expect(String(error)).toContain(`lastRenewedAt=${renewed ? acquiredAt + 100 : "never"}`);
      expect(String(error)).toContain(`attempt=${renewed ? 2 : 1}`);
      expect(String(error)).toContain(`elapsedMs=${renewed ? 20_100 : 100}`);
      if (!renewed) {
        expect(await outcome).toBe(error);
      }
    } finally {
      await heartbeat.stop();
    }
  },
);

it("reports expiry without inventing a renewal error", async () => {
  fixture.renew.mockReturnValue(undefined);
  const { heartbeat, outcome } = await start();
  try {
    const error = await outcome;
    expect(String(error)).toContain("expired or ownership lost");
    expect(error).not.toHaveProperty("cause");
  } finally {
    await heartbeat.stop();
  }
});

it.each([5, 6, 261, 517])("still retries SQLite contention errcode=%s", async (errcode) => {
  fixture.renew.mockImplementationOnce(() => {
    throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode });
  });
  const { heartbeat, outcome, onLost } = await start();
  try {
    await expect(outcome).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.renew).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
    fixture.worker?.emit("exit", 1);
    expect(String(onLost.mock.calls[0]?.[0])).toContain("exitCode=1");
    expect(String(onLost.mock.calls[0]?.[0])).toContain(`lastRenewedAt=${acquiredAt + 20_100}`);
  } finally {
    await heartbeat.stop();
  }
});
