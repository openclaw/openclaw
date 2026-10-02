import "../test-utils/prepare-compiled-subprocesses.js";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  LeaseHeartbeatParentMessage,
  LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";

const fixture = vi.hoisted(() => ({
  worker: undefined as EventEmitter | undefined,
  data: undefined as LeaseHeartbeatWorkerData | undefined,
  renew: vi.fn<() => number | undefined>(),
  readExpiry: vi.fn<() => number | undefined>(),
  receive: undefined as ((message: LeaseHeartbeatParentMessage) => void) | undefined,
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    isMainThread: false,
    get workerData() {
      return fixture.data;
    },
    parentPort: {
      on(_event: "message", listener: (message: LeaseHeartbeatParentMessage) => void) {
        fixture.receive = listener;
      },
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
      postMessage(message: LeaseHeartbeatParentMessage) {
        queueMicrotask(() => fixture.receive?.(structuredClone(message)));
      }
      async terminate() {
        this.emit("exit", 0);
        return 0;
      }
    },
  };
});
vi.mock("../infra/gateway-state-owner.js", () => ({
  assertStateDatabaseAccessAllowed() {},
  GatewayStateOwnerContentionError: class extends Error {},
}));
vi.mock("../infra/sqlite-worker-identity.js", () => ({
  readDatabasePathIdentitySync: (canonicalPath: string) => ({ key: "file:12:34", canonicalPath }),
}));
vi.mock("../infra/sqlite-busy-timeout.js", () => ({
  runWithSqliteBusyTimeout: (_db: unknown, _ms: number, run: () => unknown) => run(),
}));
vi.mock("../infra/sqlite-transaction.js", () => ({
  runSqliteImmediateTransactionSync: (_db: unknown, run: () => unknown) => run(),
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
  fixture.receive = undefined;
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
      expect(String(error)).toContain(`lossPath=${renewed ? "automatic-renewal" : "activation"}`);
      expect(String(error)).toContain("lossOutcome=operation-error");
      if (!renewed) {
        expect(await outcome).toBe(error);
      }
    } finally {
      await heartbeat.stop();
    }
  },
);

it.each([false, true])(
  "reports missing ownership without claiming expiry after success=%s",
  async (renewed) => {
    fixture.renew.mockReturnValue(undefined);
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
      expect(String(error)).toContain("expired or ownership lost");
      expect(String(error)).toContain(`lossPath=${renewed ? "automatic-renewal" : "activation"}`);
      expect(String(error)).toContain("lossOutcome=no-current-owned-unexpired-row");
      expect(error).not.toHaveProperty("cause");
    } finally {
      await heartbeat.stop();
    }
  },
);

it.each([
  ["verify", false],
  ["verify", true],
  ["renew", false],
  ["renew", true],
] as const)("retains explicit %s loss with operation error=%s", async (operation, throws) => {
  const { heartbeat, outcome, onLost } = await start();
  try {
    await expect(outcome).resolves.toBeUndefined();
    const action = operation === "verify" ? fixture.readExpiry : fixture.renew;
    action.mockImplementation(() => {
      if (throws) {
        throw new Error("synthetic operation failure");
      }
      return undefined;
    });
    const rejected = heartbeat[operation]().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await rejected).toMatchObject({
      code: throws ? "OPENCLAW_STATE_LEASE_STORAGE_FAILED" : "OPENCLAW_STATE_LEASE_LOST",
      message: expect.stringContaining(
        `lossPath=explicit-${operation}, lossOutcome=${throws ? "operation-error" : "no-current-owned-unexpired-row"}`,
      ),
      ...(throws ? { cause: { message: "synthetic operation failure" } } : {}),
    });
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(String(onLost.mock.calls[0]?.[0])).toContain(`lossPath=explicit-${operation}`);
  } finally {
    await heartbeat.stop();
  }
});

it("suppresses loss reporting during normal close and termination", async () => {
  const { heartbeat, outcome, onLost } = await start();
  await expect(outcome).resolves.toBeUndefined();
  await heartbeat.stop();
  expect(onLost).not.toHaveBeenCalled();
});

it.each([5, 6, 261, 517])("still retries SQLite contention errcode=%s", async (errcode) => {
  fixture.renew.mockImplementationOnce(() => {
    throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode });
  });
  const { heartbeat, outcome, onLost } = await start();
  try {
    await expect(outcome).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(24);
    expect(fixture.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.renew).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
    fixture.worker?.emit("exit", 1);
    expect(String(onLost.mock.calls[0]?.[0])).toContain("exitCode=1");
    expect(String(onLost.mock.calls[0]?.[0])).toContain(`lastRenewedAt=${acquiredAt + 125}`);
    expect(String(onLost.mock.calls[0]?.[0])).not.toContain("lossPath=");
  } finally {
    await heartbeat.stop();
  }
});
