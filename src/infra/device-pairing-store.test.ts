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
  closeOpenClawStateDatabaseByPath(database.path);
});

test("reloads committed pairing changes when transaction cleanup throws", () => {
  const runTransaction = stateDb.runOpenClawStateWriteTransaction;
  const transaction = vi
    .spyOn(stateDb, "runOpenClawStateWriteTransaction")
    .mockImplementationOnce((operate, options, transactionOptions) => {
      runTransaction(operate, options, transactionOptions);
      throw new Error("post-commit cleanup failed");
    });
  try {
    expect(() =>
      persistDevicePairingStoreState({ pendingById: {}, pairedByDeviceId: {} }, baseDir, "paired"),
    ).toThrow("post-commit cleanup failed");
    expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual({});
  } finally {
    transaction.mockRestore();
  }
});

test("shares pairing invalidation across module copies using the same connection", async () => {
  vi.resetModules();
  const other = await import("./device-pairing-store.js");
  expect(other.loadDevicePairingStoreState).not.toBe(loadDevicePairingStoreState);
  other.persistDevicePairingStoreState(
    { pendingById: {}, pairedByDeviceId: {} },
    baseDir,
    "paired",
  );
  expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual({});
});

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

test("reloads the pairing snapshot after reopening the database", () => {
  closeOpenClawStateDatabaseByPath(database.path);
  const reopened = stateDb.openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
  });
  expect(reopened.db === database.db).toBe(false);
  reopened.db.prepare("DELETE FROM device_pairing_paired").run();
  expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual({});
});
