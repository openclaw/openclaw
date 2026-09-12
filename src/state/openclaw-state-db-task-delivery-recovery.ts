// Doctor owns preservation-first recovery of delivery metadata whose task no longer exists.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireDirectorySync, syncDirectorySync } from "../infra/directory-durability.js";
import { hashFileDescriptorSync } from "../infra/file-descriptor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { createPrivateSqliteTempDirectorySync } from "../infra/sqlite-private-directory.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

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

function assertRecoveryShape(database: DatabaseSync): void {
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

function assertKnownOrphanIntegrity(database: DatabaseSync): number {
  const structural = database.prepare("PRAGMA integrity_check").all();
  if (structural.length !== 1 || structural[0]?.integrity_check !== "ok") {
    throw new Error("Orphan task delivery recovery requires a structurally intact database.");
  }
  let count = 0;
  const check = database.prepare("PRAGMA foreign_key_check");
  check.setReadBigInts(true);
  for (const violation of check.iterate()) {
    if (
      violation.table !== "task_delivery_state" ||
      violation.parent !== "task_runs" ||
      violation.fkid !== 0n ||
      typeof violation.rowid !== "bigint"
    ) {
      throw new Error(
        "Orphan task delivery recovery refused unrelated foreign-key violations; preserve the database for supported recovery.",
      );
    }
    count += 1;
  }
  return count;
}

function syncAndHash(filePath: string) {
  const descriptor = fs.openSync(filePath, "r+");
  try {
    fs.fsyncSync(descriptor);
    return hashFileDescriptorSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Caller holds Doctor's ownership/schema fences and its immediate write transaction.
 * Foreign-key actions stay disabled: inbound dependents must fail the post-check,
 * never cascade into unrelated data. The caller rolls back any failed check.
 */
export function recoverOrphanTaskDeliveryRows(database: DatabaseSync, pathname: string): string[] {
  if (
    !tableExists(database, "task_delivery_state") ||
    !tableExists(database, "task_runs") ||
    !database.prepare(`SELECT 1 FROM task_delivery_state WHERE ${ORPHAN_PREDICATE} LIMIT 1`).get()
  ) {
    return [];
  }
  assertRecoveryShape(database);
  const count = assertKnownOrphanIntegrity(database);
  if (!database.isTransaction) {
    throw new Error("Orphan task delivery recovery requires the Doctor write transaction.");
  }

  // The existing worker copies WAL/rollback state in another process. Opening and
  // closing source file descriptors here could release this process's SQLite locks.
  const prepared = prepareSqliteReadOnlyLocationSync(pathname);
  let recoveryDirectory: string | undefined;
  try {
    const snapshot = openNodeSqliteDatabase(prepared.location);
    try {
      snapshot.exec("PRAGMA journal_mode = DELETE;");
      assertRecoveryShape(snapshot);
      if (assertKnownOrphanIntegrity(snapshot) !== count) {
        throw new Error("Orphan task delivery snapshot changed before preservation.");
      }
      const sourceHash = createHash("sha256");
      const snapshotHash = createHash("sha256");
      for (const row of orphanRows(database)) {
        sourceHash.update(encodeOrphanRow(row));
      }
      for (const row of orphanRows(snapshot)) {
        snapshotHash.update(encodeOrphanRow(row));
      }
      if (sourceHash.digest("hex") !== snapshotHash.digest("hex")) {
        throw new Error("Orphan task delivery snapshot does not preserve the current payload.");
      }
    } finally {
      snapshot.close();
    }
    recoveryDirectory = createPrivateSqliteTempDirectorySync(
      path.dirname(pathname),
      "openclaw-task-delivery-recovery-",
    );
    const backupPath = path.join(recoveryDirectory, "database.sqlite");
    const expectedBackup = syncAndHash(prepared.location);
    fs.copyFileSync(prepared.location, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, 0o600);
    if (JSON.stringify(syncAndHash(backupPath)) !== JSON.stringify(expectedBackup)) {
      throw new Error("Orphan task delivery backup verification failed.");
    }
    const exportPath = path.join(recoveryDirectory, "orphan-rows.jsonl");
    const exportDescriptor = fs.openSync(exportPath, "wx+", 0o600);
    const exportHash = createHash("sha256");
    let exportedCount = 0;
    try {
      for (const row of orphanRows(database)) {
        const encoded = encodeOrphanRow(row);
        fs.writeFileSync(exportDescriptor, encoded);
        exportHash.update(encoded);
        exportedCount += 1;
      }
      fs.fsyncSync(exportDescriptor);
      if (hashFileDescriptorSync(exportDescriptor).sha256 !== exportHash.digest("hex")) {
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
    // Retained artifacts are recovery evidence, never a claim that this transaction committed.
    // Any later migration or integrity failure rolls the row removal back, not the backup.
    const removed = database
      .prepare(`DELETE FROM task_delivery_state WHERE ${ORPHAN_PREDICATE}`)
      .run();
    if (Number(removed.changes) !== count) {
      throw new Error("Orphan task delivery recovery removed an unexpected number of rows.");
    }
    assertSqliteIntegrity(database, pathname);
    return [
      `Preserved and recovered ${count} orphan task delivery rows; backup and row export: ${recoveryDirectory}`,
    ];
  } catch (error) {
    throw new Error(
      `Task delivery recovery failed without committing row removal${recoveryDirectory ? `; retained artifacts: ${recoveryDirectory}` : ""}: ${String(error)}`,
      { cause: error },
    );
  } finally {
    prepared.cleanup();
  }
}
