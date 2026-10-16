import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { executeDevicePairingRead } from "./device-pairing-read.kernel.js";
import {
  loadDevicePairingStoreState,
  loadPairedDevicePairingStoreRecordFromDatabase,
  persistDevicePairingStoreState,
  readDevicePairingStoreStateFromDatabase,
  readPairedDevicePairingSnapshotFromDatabase,
  updatePairedDeviceInTransaction,
  withDevicePairingStoreDatabase,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import { updatePairedDeviceMetadata } from "./device-pairing.js";
import { runSqliteReadOperationSync } from "./sqlite-schema-facts.js";
import { runWithSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

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
  const reads = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["freshness", "paired"],
    (sql) =>
      /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(sql)
        ? "freshness"
        : /\b(?:from|join) "device_pairing_paired"/iu.test(sql)
          ? "paired"
          : null,
  );
  const read = () =>
    executeDevicePairingRead(database.db, database.path, {
      type: "devicePairing.lookup",
      deviceId: "node",
    });
  const initialRevision = read().revision;
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
    expect(BigInt(read().revision)).toBe(BigInt(initialRevision) + 1n);
    expect(reads.counts).toEqual({ freshness: 0, paired: 1 });

    runSqliteReadOperationSync(database.db, () => {
      expect(read()).toMatchObject({ device: { displayName: "Worker update" } });
    });
    expect(reads.counts).toEqual({ freshness: 0, paired: 1 });
  } finally {
    reads.restore();
  }
});

test("exact pairing reads materialize only their device and never satisfy a full list", () => {
  const sibling = { ...initial.pairedByDeviceId.node!, deviceId: "sibling", approvedAtMs: 2 };
  const pending = {
    requestId: "pending",
    deviceId: "pending-node",
    publicKey: "synthetic-pending-key",
    ts: 1,
  };
  const state = {
    pairedByDeviceId: { ...initial.pairedByDeviceId, sibling },
    pendingById: { pending },
  };
  persistDevicePairingStoreState(state, baseDir, "both");
  const reads = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["paired", "pending"],
    (sql) =>
      /\b(?:from|join) "device_pairing_paired"/iu.test(sql)
        ? "paired"
        : /\bfrom "device_pairing_pending"/iu.test(sql)
          ? "pending"
          : null,
  );
  const lookup = (deviceId: string) =>
    executeDevicePairingRead(database.db, database.path, {
      type: "devicePairing.lookup",
      deviceId,
    });
  try {
    const revision = lookup("node").revision;
    expect(lookup("node")).toMatchObject({ device: initial.pairedByDeviceId.node, revision });
    expect(reads.rowCounts).toEqual({ paired: 1, pending: 0 });
    expect(lookup("sibling")).toMatchObject({ device: sibling, revision });
    expect(lookup("missing")).toMatchObject({ device: null, revision });
    expect(reads.rowCounts).toEqual({ paired: 3, pending: 0 });
    expect(reads.counts).toEqual({ paired: 3, pending: 0 });
    expect(
      executeDevicePairingRead(database.db, database.path, {
        type: "devicePairing.list",
        nowMs: 1,
      }),
    ).toMatchObject({
      list: { paired: [sibling, initial.pairedByDeviceId.node], pending: [pending] },
      revision,
    });
    expect(reads.rowCounts).toEqual({ paired: 5, pending: 1 });
    persistDevicePairingStoreState({ ...state, pendingById: {} }, baseDir, "pending");
    expect(lookup("node").revision).toBe(revision);
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
      persistDevicePairingStoreState(empty, baseDir, "paired");
    }
    expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual({});
  },
);

test.each([false, true])(
  "keeps transaction-local pairing reads out of the cache (rollback=%s)",
  (rollback) => {
    const beforeRevision = readPairedDevicePairingSnapshotFromDatabase(database.db).revision;
    const operate = () =>
      stateDb.runOpenClawStateWriteTransaction(
        () => {
          persistDevicePairingStoreState(
            { pendingById: {}, pairedByDeviceId: {} },
            baseDir,
            "paired",
          );
          expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual({});
          expect(BigInt(readPairedDevicePairingSnapshotFromDatabase(database.db).revision)).toBe(
            BigInt(beforeRevision) + 1n,
          );
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
    expect(BigInt(readPairedDevicePairingSnapshotFromDatabase(database.db).revision)).toBe(
      BigInt(beforeRevision) + (rollback ? 0n : 1n),
    );
  },
);

test.each([false, true])(
  "reuses one paired snapshot without stale reads or escaped rollback state (rollback=%s)",
  (rollback) => {
    const reads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["paired"],
      (sql) =>
        /^\s*select\b.*\b(?:from|join) "device_pairing_paired"/iu.test(sql) ? "paired" : null,
    );
    const env = { ...process.env, OPENCLAW_STATE_DIR: baseDir };
    const expected = {
      node: {
        deviceId: "node",
        publicKey: "synthetic-key",
        createdAtMs: 1,
        approvedAtMs: 1,
        remoteIp: "192.0.2.2",
        tokens: {
          operator: {
            token: "synthetic-token",
            role: "operator",
            scopes: ["operator.read"],
            createdAtMs: 2,
          },
        },
      },
      sibling: {
        deviceId: "sibling",
        publicKey: "synthetic-sibling-key",
        createdAtMs: 3,
        approvedAtMs: 3,
      },
    };
    const operate = () =>
      runWithSqliteWorkerStateContext({ environment: env }, () =>
        stateDb.runOpenClawStateWriteTransaction(
          () => {
            const paired = readDevicePairingStoreStateFromDatabase(database.db).pairedByDeviceId;
            return withDevicePairingStoreDatabase(
              database,
              () => {
                updatePairedDeviceInTransaction("node", () => ({
                  value: undefined,
                  patch: { displayName: "Temporary name", tokens: expected.node.tokens },
                }));
                const state = loadDevicePairingStoreState();
                state.pairedByDeviceId.sibling = expected.sibling;
                persistDevicePairingStoreState(state, undefined, "paired");
                updatePairedDeviceInTransaction("node", (device) => {
                  // The callback owns a copy; unpersisted edits must not enter its receipt.
                  if (device) {
                    device.publicKey = "not-persisted";
                  }
                  return {
                    value: undefined,
                    patch: { displayName: undefined, remoteIp: "192.0.2.2" },
                  };
                });
                expect(loadPairedDevicePairingStoreRecordFromDatabase(database.db, "node")).toEqual(
                  expected.node,
                );
                expect(
                  readDevicePairingStoreStateFromDatabase(database.db).pairedByDeviceId,
                ).toEqual(expected);
                expect(
                  loadPairedDevicePairingStoreRecordFromDatabase(database.db, "constructor"),
                ).toBeNull();
                expect(
                  loadPairedDevicePairingStoreRecordFromDatabase(database.db, "__proto__"),
                ).toBeNull();
                expect(reads.counts.paired).toBe(1);
                if (rollback) {
                  throw new Error("rollback pairing snapshot");
                }
              },
              paired,
            );
          },
          { database, env },
        ),
      );
    try {
      if (rollback) {
        expect(operate).toThrow("rollback pairing snapshot");
      } else {
        operate();
      }
      expect(readDevicePairingStoreStateFromDatabase(database.db).pairedByDeviceId).toEqual(
        rollback ? initial.pairedByDeviceId : expected,
      );
    } finally {
      reads.restore();
    }
  },
);
