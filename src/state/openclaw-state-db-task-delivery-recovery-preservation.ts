// Native preservation kernel shared by Doctor's child and the synchronous SDK/update-ledger path.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireDirectorySync, syncDirectorySync } from "../infra/directory-durability.js";
import {
  flushAndHashFileSync as syncAndHash,
  hashFileDescriptorSync,
} from "../infra/file-descriptor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  assertSqliteIntegrity,
  SqliteRepairableForeignKeyError,
} from "../infra/sqlite-integrity.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export type PreservedOrphanTaskDelivery = { count: number; payloadSha256: string };

const ORPHAN_PREDICATE =
  "NOT EXISTS (SELECT 1 FROM task_runs WHERE task_runs.task_id = task_delivery_state.task_id)";

type OrphanDeliveryRow = {
  rowid: bigint;
  task_id: string;
  requester_origin_json: string | null;
  last_notified_event_at: bigint | null;
};

function orphanRows(database: DatabaseSync): Iterable<OrphanDeliveryRow> {
  const statement = database.prepare(`SELECT rowid, * FROM task_delivery_state
    WHERE ${ORPHAN_PREDICATE} ORDER BY rowid`);
  statement.setReadBigInts(true);
  // SAFETY: The caller checks the supported schema; encodeOrphanRow validates every legacy value before preservation or removal.
  return statement.iterate() as Iterable<OrphanDeliveryRow>;
}

function encodeOrphanRow(row: OrphanDeliveryRow): string {
  if (
    typeof row.rowid !== "bigint" ||
    typeof row.task_id !== "string" ||
    (row.requester_origin_json !== null && typeof row.requester_origin_json !== "string") ||
    (row.last_notified_event_at !== null && typeof row.last_notified_event_at !== "bigint")
  ) {
    throw new Error("Orphan task delivery values do not match the supported recovery contract.");
  }
  return `${JSON.stringify(row, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`;
}

export function assertOrphanTaskDeliveryRecoveryShape(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_xinfo(task_delivery_state)").all();
  const expected = [
    { cid: 0, name: "task_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1, hidden: 0 },
    {
      cid: 1,
      name: "requester_origin_json",
      type: "TEXT",
      notnull: 0,
      dflt_value: null,
      pk: 0,
      hidden: 0,
    },
    {
      cid: 2,
      name: "last_notified_event_at",
      type: "INTEGER",
      notnull: 0,
      dflt_value: null,
      pk: 0,
      hidden: 0,
    },
  ];
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(task_delivery_state)").all();
  const canonicalForeignKey = [
    {
      id: 0,
      seq: 0,
      table: "task_runs",
      from: "task_id",
      to: "task_id",
      on_update: "NO ACTION",
      on_delete: "CASCADE",
      match: "NONE",
    },
  ];
  const triggers = database
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'task_delivery_state'",
    )
    .get();
  if (
    JSON.stringify(columns) !== JSON.stringify(expected) ||
    JSON.stringify(foreignKeys) !== JSON.stringify(canonicalForeignKey) ||
    triggers
  ) {
    throw new Error(
      "Orphan task delivery recovery refused an unrecognized table, foreign key, or trigger.",
    );
  }
}

export function assertKnownOrphanTaskDeliveryIntegrity(database: DatabaseSync): number {
  try {
    assertSqliteIntegrity(database, "task delivery recovery database");
    return 0;
  } catch (error) {
    if (error instanceof SqliteRepairableForeignKeyError) {
      return error.repair.orphanCount;
    }
    throw error;
  }
}

export function hasOrphanTaskDeliveryRows(database: DatabaseSync): boolean {
  return (
    tableExists(database, "task_delivery_state") &&
    tableExists(database, "task_runs") &&
    Boolean(
      database.prepare(`SELECT 1 FROM task_delivery_state WHERE ${ORPHAN_PREDICATE} LIMIT 1`).get(),
    )
  );
}

function hashOrphanRows(database: DatabaseSync): PreservedOrphanTaskDelivery {
  const hash = createHash("sha256");
  let count = 0;
  for (const row of orphanRows(database)) {
    hash.update(encodeOrphanRow(row));
    count += 1;
  }
  return { count, payloadSha256: hash.digest("hex") };
}

/** Caller owns the immediate transaction and reasserts the live database owner before this step. */
export function applyOrphanTaskDeliveryRecovery(
  database: DatabaseSync,
  pathname: string,
  expected: PreservedOrphanTaskDelivery,
  recoveryDirectory: string,
): string[] {
  if (!database.isTransaction) {
    throw new Error("Orphan task delivery recovery requires the Doctor write transaction.");
  }
  assertOrphanTaskDeliveryRecoveryShape(database);
  const current = hashOrphanRows(database);
  if (current.count !== expected.count || current.payloadSha256 !== expected.payloadSha256) {
    throw new Error("Orphan task delivery snapshot does not preserve the current payload.");
  }
  const removed = database
    .prepare(`DELETE FROM task_delivery_state WHERE ${ORPHAN_PREDICATE}`)
    .run();
  if (Number(removed.changes) !== expected.count) {
    throw new Error("Orphan task delivery recovery removed an unexpected number of rows.");
  }
  assertSqliteIntegrity(database, pathname);
  return [
    `Preserved and recovered ${expected.count} orphan task delivery rows; backup and row export: ${recoveryDirectory}`,
  ];
}

/** Runs on private bytes only; source descriptors and native locks stay with their original owner. */
export function preserveOrphanTaskDeliveryRecoveryInProcess(
  snapshotPath: string,
  pathname: string,
  recoveryDirectory: string,
): PreservedOrphanTaskDelivery {
  const snapshot = openNodeSqliteDatabase(snapshotPath);
  try {
    snapshot.exec("PRAGMA journal_mode = DELETE;");
    assertOrphanTaskDeliveryRecoveryShape(snapshot);
    const count = assertKnownOrphanTaskDeliveryIntegrity(snapshot);
    if (count === 0) {
      throw new Error("Orphan task delivery snapshot no longer contains orphan rows.");
    }
    const backupPath = path.join(recoveryDirectory, "database.sqlite");
    const expectedBackup = syncAndHash(snapshotPath);
    fs.copyFileSync(snapshotPath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, 0o600);
    if (JSON.stringify(syncAndHash(backupPath)) !== JSON.stringify(expectedBackup)) {
      throw new Error("Orphan task delivery backup verification failed.");
    }
    const exportPath = path.join(recoveryDirectory, "orphan-rows.jsonl");
    const exportDescriptor = fs.openSync(exportPath, "wx+", 0o600);
    const exportHash = createHash("sha256");
    let exportedCount = 0;
    let payloadSha256: string;
    try {
      for (const row of orphanRows(snapshot)) {
        const encoded = encodeOrphanRow(row);
        fs.writeFileSync(exportDescriptor, encoded);
        exportHash.update(encoded);
        exportedCount += 1;
      }
      fs.fsyncSync(exportDescriptor);
      payloadSha256 = exportHash.digest("hex");
      if (hashFileDescriptorSync(exportDescriptor).sha256 !== payloadSha256) {
        throw new Error("Orphan task delivery export verification failed.");
      }
    } finally {
      fs.closeSync(exportDescriptor);
    }
    if (exportedCount !== count) {
      throw new Error(
        "Orphan task delivery export did not account for every foreign-key violation.",
      );
    }
    fs.writeFileSync(
      path.join(recoveryDirectory, "manifest.json"),
      JSON.stringify(
        {
          format: "openclaw.task-delivery-recovery.v1",
          state: "preserved-before-repair",
          sourcePath: pathname,
          backup: {
            file: "database.sqlite",
            ...expectedBackup,
            integrity: "structural-ok-known-orphans",
          },
          export: {
            file: "orphan-rows.jsonl",
            ...syncAndHash(exportPath),
            count,
            integerEncoding: "decimal-string",
          },
          relation: "task_delivery_state.task_id -> task_runs.task_id",
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600, flush: true },
    );
    requireDirectorySync(syncDirectorySync(recoveryDirectory), "Task delivery recovery directory");
    requireDirectorySync(
      syncDirectorySync(path.dirname(recoveryDirectory)),
      "Task delivery recovery parent",
    );
    return { count, payloadSha256 };
  } finally {
    snapshot.close();
  }
}
