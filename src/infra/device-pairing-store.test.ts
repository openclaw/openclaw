import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { executeDevicePairingRead } from "./device-pairing-read.kernel.js";
import {
  loadDevicePairingStoreState,
  persistDevicePairingStoreState,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import { updatePairedDeviceMetadata } from "./device-pairing.js";
import { runSqliteReadOperationSync } from "./sqlite-schema-facts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let baseDir: string;
let database: ReturnType<typeof stateDb.openOpenClawStateDatabase>;
let initial: DevicePairingStoreState;

beforeEach(() => {
  baseDir = tempDirs.make("device-pairing-cache-");
  database = stateDb.openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
  });
  initial = {
    pendingById: {},
    pairedByDeviceId: {
      node: { deviceId: "node", publicKey: "synthetic-key", createdAtMs: 1, approvedAtMs: 1 },
    },
  };
  persistDevicePairingStoreState(initial, baseDir, "both");
  expect(loadDevicePairingStoreState(baseDir)).toEqual(initial);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseByPathAsync(database.path);
});

test("invalidates retained pairing rows after a worker commit without freshness probes", async () => {
  const reads = trackSqliteStatementExecutions(database.db, ["freshness", "paired"], (sql) =>
    /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(sql)
      ? "freshness"
      : /\bfrom "device_pairing_paired"/iu.test(sql)
        ? "paired"
        : null,
  );
  const read = () =>
    executeDevicePairingRead(database.db, database.path, {
      type: "devicePairing.lookup",
      deviceId: "node",
    });
  try {
    runSqliteReadOperationSync(database.db, () => {
      expect(read()).toMatchObject({ device: { publicKey: "synthetic-key" } });
      expect(read()).toMatchObject({ device: { publicKey: "synthetic-key" } });
    });
    expect(reads.counts).toEqual({ freshness: 0, paired: 0 });

    expect(
      await updatePairedDeviceMetadata("node", { displayName: "Worker update" }, baseDir),
    ).toBe(true);
    expect(read()).toMatchObject({ device: { displayName: "Worker update" } });
    expect(reads.counts).toEqual({ freshness: 0, paired: 1 });

    runSqliteReadOperationSync(database.db, () => {
      expect(read()).toMatchObject({ device: { displayName: "Worker update" } });
    });
    expect(reads.counts).toEqual({ freshness: 0, paired: 1 });
  } finally {
    reads.restore();
  }
});

test.each(["cleanup failure", "module copy", "reopened connection"])(
  "reloads committed pairing changes after %s",
  async (trigger) => {
    const empty = { pendingById: {}, pairedByDeviceId: {} };
    if (trigger === "cleanup failure") {
      const runTransaction = stateDb.runOpenClawStateWriteTransaction;
      vi.spyOn(stateDb, "runOpenClawStateWriteTransaction").mockImplementationOnce(
        (operate, options, transactionOptions) => {
          runTransaction(operate, options, transactionOptions);
          throw new Error("post-commit cleanup failed");
        },
      );
      expect(() => persistDevicePairingStoreState(empty, baseDir, "paired")).toThrow(
        "post-commit cleanup failed",
      );
    } else if (trigger === "module copy") {
      vi.resetModules();
      const other = await import("./device-pairing-store.js");
      expect(other.loadDevicePairingStoreState).not.toBe(loadDevicePairingStoreState);
      other.persistDevicePairingStoreState(empty, baseDir, "paired");
    } else {
      await closeOpenClawStateDatabaseByPathAsync(database.path);
      const reopened = stateDb.openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
      });
      expect(reopened.db === database.db).toBe(false);
      reopened.db.prepare("DELETE FROM device_pairing_paired").run();
    }
    expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual({});
  },
);

test.each([false, true])(
  "keeps transaction-local pairing reads out of the cache (rollback=%s)",
  (rollback) => {
    const operate = () =>
      stateDb.runOpenClawStateWriteTransaction(
        () => {
          persistDevicePairingStoreState(
            { pendingById: {}, pairedByDeviceId: {} },
            baseDir,
            "paired",
          );
          expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual({});
          if (rollback) {
            throw new Error("rollback pairing");
          }
        },
        { database, env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } },
      );
    if (rollback) {
      expect(operate).toThrow("rollback pairing");
    } else {
      operate();
    }
    expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual(
      rollback ? initial.pairedByDeviceId : {},
    );
  },
);
