import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import * as stateDb from "../state/openclaw-state-db.js";
import {
  loadDevicePairingStoreState,
  persistDevicePairingStoreState,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";

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

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseByPath(database.path);
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
      closeOpenClawStateDatabaseByPath(database.path);
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
