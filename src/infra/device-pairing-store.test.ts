import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { executeDevicePairingRead as read } from "./device-pairing-read.kernel.js";
import {
  loadDevicePairingStoreState as loadState,
  loadPairedDevicePairingStoreRecordFromDatabase as loadPaired,
  persistDevicePairingStoreState as persistState,
  readDevicePairingStoreStateFromDatabase as readState,
  readPairedDevicePairingSnapshotFromDatabase as readSnapshot,
  updatePairedDeviceInTransaction as updatePaired,
  withDevicePairingStoreDatabase as withDatabase,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import { updatePairedDeviceMetadata as updateMetadata } from "./device-pairing.js";
import { runSqliteReadOperationSync } from "./sqlite-schema-facts.js";
import {
  runWithSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "./sqlite-worker-state-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let baseDir: string;
let database: ReturnType<typeof stateDb.openOpenClawStateDatabase>;
let initial: DevicePairingStoreState;
let env: SqliteWorkerStateContext["environment"];
const emptyState: DevicePairingStoreState = { pendingById: {}, pairedByDeviceId: {} };
const nodeRecord = { deviceId: "node", publicKey: "node-key", createdAtMs: 1, approvedAtMs: 1 };
const restorers = new Set<() => void>();

function trackReads(patterns: Record<string, RegExp>) {
  const reads = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    Object.keys(patterns),
    (sql) => Object.keys(patterns).find((key) => patterns[key]!.test(sql)) ?? null,
  );
  restorers.add(reads.restore);
  return reads;
}

function write<T>(operate: () => T): T {
  return stateDb.runOpenClawStateWriteTransaction(operate, { database, env });
}

function lookup(deviceId = "node") {
  return read(database.db, database.path, { type: "devicePairing.lookup", deviceId });
}

function expectTransaction(operate: () => unknown, rollback: boolean, message: string) {
  if (rollback) {
    expect(operate).toThrow(message);
  } else {
    operate();
  }
}

beforeEach(() => {
  baseDir = tempDirs.make("device-pairing-cache-");
  env = { ...process.env, OPENCLAW_STATE_DIR: baseDir };
  database = stateDb.openOpenClawStateDatabase({ env });
  initial = { pendingById: {}, pairedByDeviceId: { node: { ...nodeRecord } } };
  persistState(initial, baseDir, "both");
  expect(loadState(baseDir)).toEqual(initial);
});

afterEach(async () => {
  for (const restore of restorers) {
    restore();
  }
  restorers.clear();
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseByPathAsync(database.path);
});

test("invalidates retained pairing rows after a worker commit without freshness probes", async () => {
  const reads = trackReads({
    freshness: /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu,
    paired: /\b(?:from|join) "device_pairing_paired"/iu,
  });
  const initialRevision = lookup().revision;
  runSqliteReadOperationSync(database.db, () => {
    expect(lookup()).toMatchObject({ device: { publicKey: "node-key" } });
    expect(lookup()).toMatchObject({ device: { publicKey: "node-key" } });
  });
  expect(reads.counts).toEqual({ freshness: 0, paired: 0 });

  expect(await updateMetadata("node", { displayName: "Worker update" }, baseDir)).toBe(true);
  expect(lookup()).toMatchObject({ device: { displayName: "Worker update" } });
  expect(BigInt(lookup().revision)).toBe(BigInt(initialRevision) + 1n);
  expect(reads.counts).toEqual({ freshness: 0, paired: 1 });

  runSqliteReadOperationSync(database.db, () => {
    expect(lookup()).toMatchObject({ device: { displayName: "Worker update" } });
  });
  expect(reads.counts).toEqual({ freshness: 0, paired: 1 });
});

test("exact pairing reads materialize only their device and never satisfy a full list", () => {
  const sibling = { ...nodeRecord, deviceId: "sibling", approvedAtMs: 2 };
  const pending = {
    requestId: "pending",
    deviceId: "pending-node",
    publicKey: "pending-key",
    ts: 1,
  };
  const state = {
    pairedByDeviceId: { ...initial.pairedByDeviceId, sibling },
    pendingById: { pending },
  };
  persistState(state, baseDir, "both");
  const reads = trackReads({
    paired: /\b(?:from|join) "device_pairing_paired"/iu,
    pending: /\bfrom "device_pairing_pending"/iu,
  });
  const revision = lookup("node").revision;
  expect(lookup("node")).toMatchObject({ device: initial.pairedByDeviceId.node, revision });
  expect(reads.rowCounts).toEqual({ paired: 1, pending: 0 });
  expect(lookup("sibling")).toMatchObject({ device: sibling, revision });
  expect(lookup("missing")).toMatchObject({ device: null, revision });
  expect(reads).toMatchObject({
    rowCounts: { paired: 3, pending: 0 },
    counts: { paired: 3, pending: 0 },
  });
  expect(read(database.db, database.path, { type: "devicePairing.list", nowMs: 1 })).toMatchObject({
    list: { paired: [sibling, initial.pairedByDeviceId.node], pending: [pending] },
    revision,
  });
  expect(reads.rowCounts).toEqual({ paired: 5, pending: 1 });
  persistState({ ...state, pendingById: {} }, baseDir, "pending");
  expect(lookup("node").revision).toBe(revision);
});

test.each(["cleanup failure", "module copy", "reopened connection"])(
  "reloads committed pairing state after %s",
  async (trigger) => {
    if (trigger === "cleanup failure") {
      const runTransaction = stateDb.runOpenClawStateWriteTransaction;
      vi.spyOn(stateDb, "runOpenClawStateWriteTransaction").mockImplementationOnce((...args) => {
        runTransaction(...args);
        throw new Error("post-commit cleanup failed");
      });
      expect(() => persistState(emptyState, baseDir, "paired")).toThrow(
        "post-commit cleanup failed",
      );
    } else if (trigger === "module copy") {
      vi.resetModules();
      const other = await import("./device-pairing-store.js");
      expect(other.loadDevicePairingStoreState).not.toBe(loadState);
      other.persistDevicePairingStoreState(emptyState, baseDir, "paired");
    } else {
      await closeOpenClawStateDatabaseByPathAsync(database.path);
      const reopened = stateDb.openOpenClawStateDatabase({ env });
      expect(reopened.db === database.db).toBe(false);
      persistState(emptyState, baseDir, "paired");
    }
    expect(loadState(baseDir).pairedByDeviceId).toEqual({});
  },
);

test.each([false, true])("keeps transaction-local reads uncached (rollback=%s)", (rollback) => {
  const beforeRevision = readSnapshot(database.db).revision;
  const operate = () =>
    write(() => {
      persistState(emptyState, baseDir, "paired");
      expect(loadState(baseDir).pairedByDeviceId).toEqual({});
      expect(BigInt(readSnapshot(database.db).revision)).toBe(BigInt(beforeRevision) + 1n);
      if (rollback) {
        throw new Error("rollback pairing");
      }
    });
  expectTransaction(operate, rollback, "rollback pairing");
  expect(loadState(baseDir).pairedByDeviceId).toEqual(rollback ? initial.pairedByDeviceId : {});
  expect(BigInt(readSnapshot(database.db).revision)).toBe(
    BigInt(beforeRevision) + (rollback ? 0n : 1n),
  );
});

test.each([false, true])("isolates reused snapshots (rollback=%s)", (rollback) => {
  const execute = vi.spyOn(database.db, "exec");
  const reads = trackReads({ paired: /^\s*select\b.*\b(?:from|join) "device_pairing_paired"/iu });
  const tokens = {
    operator: { token: "tok", role: "operator", scopes: ["operator.read"], createdAtMs: 2 },
  };
  const expected = {
    node: { ...nodeRecord, remoteIp: "192.0.2.2", tokens },
    sibling: { deviceId: "sibling", publicKey: "sibling-key", createdAtMs: 3, approvedAtMs: 3 },
  };
  const operate = () =>
    runWithSqliteWorkerStateContext({ environment: env }, () =>
      write(() =>
        withDatabase(
          database,
          () => {
            updatePaired("node", () => ({
              value: undefined,
              patch: { displayName: "Temporary name", tokens },
            }));
            const state = loadState();
            state.pairedByDeviceId.sibling = expected.sibling;
            persistState(state, undefined, "paired");
            updatePaired("node", (device) => {
              // The callback owns a copy; unpersisted edits must not enter its receipt.
              if (device) {
                device.publicKey = "not-persisted";
              }
              return {
                value: undefined,
                patch: { displayName: undefined, remoteIp: "192.0.2.2" },
              };
            });
            expect(loadPaired(database.db, "node")).toEqual(expected.node);
            expect(readState(database.db).pairedByDeviceId).toEqual(expected);
            expect(loadPaired(database.db, "constructor")).toBeNull();
            expect(loadPaired(database.db, "__proto__")).toBeNull();
            expect(reads.counts.paired).toBe(1);
            if (rollback) {
              throw new Error("rollback pairing snapshot");
            }
          },
          readState(database.db).pairedByDeviceId,
        ),
      ),
    );
  expectTransaction(operate, rollback, "rollback pairing snapshot");
  expect(
    execute.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /^(SAVEPOINT|RELEASE|ROLLBACK TO)\b/iu.test(sql)),
  ).toEqual([]);
  const committed = readState(database.db).pairedByDeviceId;
  expect(committed).toEqual(rollback ? initial.pairedByDeviceId : expected);
});
