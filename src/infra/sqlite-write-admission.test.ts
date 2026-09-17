import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { retainSqliteWriteAdmissionService } from "./sqlite-write-admission.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
  StateDatabaseCoordinatorContentionError,
} from "./state-database-coordinator.js";

const native = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./node-sqlite.js", () => ({
  openNodeSqliteDatabase: native.open,
  requireNodeSqlite() {
    throw new Error("Admission control must not open native SQLite");
  },
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
const releases: (() => void)[] = [];
let now = 0;

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  for (const release of releases.splice(0)) {
    release();
  }
  vi.restoreAllMocks();
  native.open.mockReset();
});

function retain(location: string, service: () => void) {
  const release = retainSqliteWriteAdmissionService([location], service);
  releases.push(release);
  return release;
}

function fixture() {
  const directory = directories.make("sqlite-admission-control-");
  const databasePath = path.join(directory, "state.sqlite");
  const lockFailure = Object.assign(new Error("synthetic admission contention"), { errcode: 5 });
  let admitted = false;
  let busyTimeoutMs = 0;
  let nativeAttempts = 0;
  const database = {
    isOpen: true,
    isTransaction: false,
    location: () => databasePath,
    prepare: (sql: string) => {
      expect(sql).toBe("PRAGMA busy_timeout");
      return { get: () => ({ timeout: busyTimeoutMs }) };
    },
    exec: (sql: string) => {
      const busy = /PRAGMA busy_timeout = (\d+)/.exec(sql);
      if (busy) {
        busyTimeoutMs = Number(busy[1]);
      }
      if (/BEGIN (?:EXCLUSIVE|IMMEDIATE)/.test(sql)) {
        nativeAttempts += 1;
        if (!admitted) {
          now += busyTimeoutMs;
          throw lockFailure;
        }
        database.isTransaction = true;
      }
      if (/ROLLBACK|COMMIT/.test(sql)) {
        database.isTransaction = false;
      }
    },
    close: () => {
      database.isOpen = false;
    },
  };
  native.open.mockReturnValue(database);
  return {
    database,
    databasePath,
    options: { databasePath, runtimeDirectory: directory, busyTimeoutMs: 100 },
    admit(this: void) {
      admitted = true;
    },
    get busyTimeoutMs() {
      return busyTimeoutMs;
    },
    get nativeAttempts() {
      return nativeAttempts;
    },
  };
}

describe("SQLite acquisition with retained worker admission", () => {
  it("services the original data owner while its lifecycle lock is contended", () => {
    const control = fixture();
    const service = vi.fn(control.admit);
    const unrelated = vi.fn();
    retain(control.databasePath, service);
    retain(`${control.databasePath}.other`, unrelated);

    const lease = acquireStateDatabaseCoordinator(control.options);
    try {
      expect(service).toHaveBeenCalledOnce();
      expect(unrelated).not.toHaveBeenCalled();
      expect(lease.path).not.toBe(control.databasePath);
      expect(control.database.isTransaction).toBe(true);
      expect(control.busyTimeoutMs).toBe(100);
    } finally {
      lease.release();
    }
    expect(control.database.isOpen).toBe(false);
  });

  it("counts service time against the original acquisition deadline", () => {
    const control = fixture();
    const service = vi.fn(() => {
      now += control.options.busyTimeoutMs;
      control.admit();
    });
    retain(control.databasePath, service);

    expect(() => acquireStateDatabaseCoordinator(control.options)).toThrow(
      StateDatabaseCoordinatorContentionError,
    );
    expect(service).toHaveBeenCalledOnce();
    expect(control.nativeAttempts).toBe(1);
    expect(control.database.isOpen).toBe(false);
  });

  it.each([false, true])(
    "preserves service failure identity without retry (lock error: %s)",
    (lock) => {
      const control = fixture();
      const failure = Object.assign(
        new Error("source authority refused"),
        lock ? { errcode: 5 } : {},
      );
      const service = vi.fn(() => {
        throw failure;
      });
      retain(control.databasePath, service);

      let observed: unknown;
      try {
        acquireStateDatabaseCoordinator(control.options);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(failure);
      expect(service).toHaveBeenCalledOnce();
      expect(control.nativeAttempts).toBe(1);
      expect(control.database.isOpen).toBe(false);
    },
  );

  it("services a replacement registration without calling its retired predecessor again", () => {
    const control = fixture();
    const replacement = vi.fn(control.admit);
    const initial = vi.fn(() => {
      releaseInitial();
      retain(control.databasePath, replacement);
    });
    const releaseInitial = retain(control.databasePath, initial);

    const lease = acquireStateDatabaseCoordinator(control.options);
    try {
      expect(initial).toHaveBeenCalledOnce();
      expect(replacement).toHaveBeenCalledOnce();
    } finally {
      lease.release();
    }
  });

  it("does not service data admission while acquiring the Gateway lifetime lock", () => {
    const control = fixture();
    const service = vi.fn(control.admit);
    retain(control.databasePath, service);

    expect(() => acquireGatewayLifecycleCoordinator(control.options)).toThrow(
      StateDatabaseCoordinatorContentionError,
    );
    expect(service).not.toHaveBeenCalled();
    expect(control.nativeAttempts).toBe(1);
  });

  it("does not invoke a pending service when native acquisition succeeds immediately", () => {
    const control = fixture();
    control.admit();
    const service = vi.fn();
    retain(control.databasePath, service);

    const lease = acquireStateDatabaseCoordinator(control.options);
    lease.release();
    expect(service).not.toHaveBeenCalled();
    expect(control.nativeAttempts).toBe(1);
  });

  it("retains the same service owner for native data transactions and runs the mutation once", () => {
    const control = fixture();
    const service = vi.fn(control.admit);
    retain(control.databasePath, service);
    const database = openNodeSqliteDatabase(control.databasePath);
    database.exec("PRAGMA busy_timeout = 100");
    const mutation = vi.fn(() => "committed");

    expect(runSqliteImmediateTransactionSync(database, mutation)).toBe("committed");
    expect(service).toHaveBeenCalledOnce();
    expect(mutation).toHaveBeenCalledOnce();
    expect(database.isTransaction).toBe(false);
    expect(control.busyTimeoutMs).toBe(100);
  });
});
