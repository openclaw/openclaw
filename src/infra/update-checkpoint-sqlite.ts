import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { INSTALLED_PLUGIN_INDEX_STATE_KEY } from "../plugins/installed-plugin-index-row.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { assertSqliteIntegrity, iterateSqliteSnapshotTableRows } from "./sqlite-integrity.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-readonly-location.js";
import {
  readSqliteSchemaObjects,
  readSqliteSnapshotHeader,
  readSqliteTableList,
  readSqliteTableXInfo,
} from "./sqlite-schema-contract.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import {
  checkpointPluginIndexMutationsMatch,
  type UpdateCheckpointPluginIndexMutation,
} from "./update-checkpoint-plugin-index.js";

/** Preserve the live SQLite family, including a closed WAL-mode source. */
export async function createUpdateCheckpointSqliteSnapshot(params: {
  sourcePath: string;
  targetPath: string;
  assertQuiescent: () => void;
}) {
  params.assertQuiescent();
  const prepared = await prepareSqliteReadOnlyLocation(params.sourcePath);
  try {
    params.assertQuiescent();
    return await createVerifiedSqliteSnapshot({
      sourcePath: prepared.location,
      targetPath: params.targetPath,
      preserveRowIds: true,
      requireNonEmptySource: true,
      beforePublish: params.assertQuiescent,
    });
  } finally {
    prepared.cleanup();
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
function schemaObjects(db: DatabaseSync): SchemaObject[] {
  return readSqliteSchemaObjects(db, true);
}
function tableShape(objects: SchemaObject[], table: string): string {
  return JSON.stringify(objects.filter((entry) => entry.tbl_name === table));
}
type Row = Record<string, SQLOutputValue>;
function rowJson(row: Row): string;
function rowJson(row: Row | undefined): string | undefined;
function rowJson(row: Row | undefined): string | undefined {
  return JSON.stringify(row, (_key, value: unknown) => {
    if (typeof value === "bigint") {
      return { integer: value.toString() };
    }
    if (value instanceof Uint8Array) {
      return { blob: Buffer.from(value).toString("hex") };
    }
    return value;
  });
}
function rowIdentityColumn(db: DatabaseSync, table: string) {
  if (readSqliteTableList(db).some((row) => row.name === table && row.wr === 1)) {
    return null;
  }
  const columns = readSqliteTableXInfo(db, table);
  const alias = (["rowid", "_rowid_", "oid"] as const).find((name) =>
    columns.every((column) => String(column.name).toLowerCase() !== name),
  );
  if (!alias || columns.some((column) => column.name === "checkpoint_rowid")) {
    throw new UpdateCheckpointPreservationUnavailable(table);
  }
  return alias;
}
function readRows(db: DatabaseSync, table: string): Row[] {
  const rowid = rowIdentityColumn(db, table);
  return [...iterateSqliteSnapshotTableRows(db, table, rowid, "checkpoint_rowid")];
}
function rowsEqual(left: Row[], right: Row[]): boolean {
  const a = left.map((row) => rowJson(row)).toSorted(),
    b = right.map((row) => rowJson(row)).toSorted();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function rowsMatch(left: DatabaseSync, right: DatabaseSync, table: string): boolean {
  return rowsEqual(readRows(left, table), readRows(right, table));
}

// These are completion checkpoints, not database schema identity. Startup writes
// them after the update-owned afterimage. Preserve them only in an unchanged
// schema; unknown formats and all other metadata retain the strict reversal rule.
function isStartupCheckpoint(row: Row): boolean {
  const parts = typeof row.app_version === "string" ? row.app_version.split("\n") : [];
  return (
    (row.meta_key === "state-migrations" || row.meta_key === "startup-migrations") &&
    row.role === "global" &&
    row.agent_id === null &&
    row.schema_version === 3n &&
    parts.length === 6 &&
    parts[1] === "3" &&
    parts.every((part) => part.trim().length > 0)
  );
}
function isKnownStartupCheckpoint(row: Row): boolean {
  // Format 2 is the supported legacy build-only checkpoint. Its writer upgrades
  // the same declared key; unknown future formats are not ours to reconcile.
  const parts = typeof row.app_version === "string" ? row.app_version.split("\n") : [];
  return (
    isStartupCheckpoint(row) ||
    ((row.meta_key === "state-migrations" || row.meta_key === "startup-migrations") &&
      row.role === "global" &&
      row.agent_id === null &&
      row.schema_version === 2n &&
      parts.length === 2 &&
      parts.every((part) => part.trim().length > 0))
  );
}
function sameSqliteSchema(left: DatabaseSync, right: DatabaseSync): boolean {
  return (
    JSON.stringify(readSqliteSnapshotHeader(left)) ===
      JSON.stringify(readSqliteSnapshotHeader(right)) &&
    JSON.stringify(schemaObjects(left)) === JSON.stringify(schemaObjects(right))
  );
}
function restoredMetadata(checkpoint: DatabaseSync, current: DatabaseSync): Row[] {
  const before = readRows(checkpoint, "schema_meta");
  if (!sameSqliteSchema(checkpoint, current)) {
    return before;
  }
  const completed = readRows(current, "schema_meta").filter(isStartupCheckpoint);
  if (completed.length === 0) {
    return before;
  }
  const keys = new Set(completed.map((row) => row.meta_key));
  const merged = [
    ...before.filter((row) => !isKnownStartupCheckpoint(row) || !keys.has(row.meta_key)),
    ...completed,
  ];
  const identities = new Set<SQLOutputValue>(),
    names = new Set<SQLOutputValue>();
  for (const row of merged) {
    if (
      names.has(row.meta_key!) ||
      (row.checkpoint_rowid !== undefined && identities.has(row.checkpoint_rowid))
    ) {
      // Neither a new row identity nor loss of a retained row is authorized.
      throw new UpdateCheckpointPreservationUnavailable("schema_meta");
    }
    names.add(row.meta_key!);
    if (row.checkpoint_rowid !== undefined) {
      identities.add(row.checkpoint_rowid);
    }
  }
  return merged;
}

/** Shape-compatible rows stay current; only the exactly bound plugin row may rewind. */
function mergeRows(
  checkpoint: DatabaseSync,
  afterUpdate: DatabaseSync,
  current: DatabaseSync,
  table: string,
): Row[] {
  const currentRows = readRows(current, table);
  if (table !== "config_machine_state") {
    return currentRows;
  }
  const isIndex = (row: Row) => row.state_key === INSTALLED_PLUGIN_INDEX_STATE_KEY;
  const before = readRows(checkpoint, table).find(isIndex);
  const after = readRows(afterUpdate, table).find(isIndex);
  if (rowJson(before) === rowJson(after)) {
    return currentRows;
  }
  const live = currentRows.find(isIndex);
  if (rowJson(live) === rowJson(before)) {
    return currentRows;
  }
  if (rowJson(live) !== rowJson(after)) {
    throw new UpdateCheckpointPreservationUnavailable(table);
  }
  return [...currentRows.filter((row) => !isIndex(row)), ...(before ? [before] : [])];
}

export class UpdateCheckpointPreservationUnavailable extends Error {
  constructor(readonly resource: string) {
    super(`Newer work cannot be preserved in the checkpoint schema: ${resource}`);
  }
}

/** Validate the exact old schema after all owner callbacks, before sealing. */
export function assertUpdateCheckpointSqliteSchema(
  checkpoint: DatabaseSync,
  staged: DatabaseSync,
  preservedCurrent: DatabaseSync = checkpoint,
): void {
  if (
    JSON.stringify(readSqliteSnapshotHeader(checkpoint)) !==
    JSON.stringify(readSqliteSnapshotHeader(staged))
  ) {
    throw new Error("Checkpoint SQLite schema identity mismatch");
  }
  if (JSON.stringify(schemaObjects(checkpoint)) !== JSON.stringify(schemaObjects(staged))) {
    throw new Error("Checkpoint SQLite schema objects mismatch");
  }
  if (
    schemaObjects(checkpoint).some(
      (entry) => entry.type === "table" && entry.name === "schema_meta",
    ) &&
    !rowsEqual(restoredMetadata(checkpoint, preservedCurrent), readRows(staged, "schema_meta"))
  ) {
    throw new Error("Checkpoint SQLite schema metadata mismatch");
  }
  assertSqliteIntegrity(staged, "restored checkpoint schema");
}

/** Keep virtual/shadow tables in a verified snapshot, never generic INSERT copies. */
export function selectUpdateCheckpointSqliteBase(params: {
  checkpoint: DatabaseSync;
  afterUpdate: DatabaseSync;
  current: DatabaseSync;
}): "checkpoint" | "current" {
  const before = schemaObjects(params.checkpoint);
  if (!before.some((entry) => /CREATE\s+VIRTUAL\s+TABLE/iu.test(entry.sql ?? ""))) {
    return "checkpoint";
  }
  if (
    JSON.stringify(before) !== JSON.stringify(schemaObjects(params.afterUpdate)) ||
    JSON.stringify(before) !== JSON.stringify(schemaObjects(params.current))
  ) {
    return "checkpoint";
  }
  return "current";
}

/**
 * Plan first, then carry CURRENT data into a checkpoint copy. Changed-schema tables
 * may rewind only when they still match the exact post-migration image. Shape-compatible
 * tables retain all current rows, including interval writes. Only the exact
 * plugin-index receipt chain binds a row reversal. Recovery rows have a separate owning carry-forward.
 * No schema version is invented and no live database is mutated here.
 */
export function carryForwardUpdateCheckpointSqlite(params: {
  checkpoint: DatabaseSync;
  afterUpdate: DatabaseSync;
  current: DatabaseSync;
  staged: DatabaseSync;
  databasePath?: string;
  pluginIndexMutations?: readonly UpdateCheckpointPluginIndexMutation[];
}): { preservedTables: string[]; restoredTables: string[] } {
  if (
    !checkpointPluginIndexMutationsMatch({
      mutations: params.pluginIndexMutations ?? [],
      databasePath: params.databasePath ?? "",
      checkpoint: params.checkpoint,
      afterUpdate: params.afterUpdate,
    })
  ) {
    throw new UpdateCheckpointPreservationUnavailable(
      params.databasePath ?? "config_machine_state",
    );
  }
  const previousObjects = schemaObjects(params.checkpoint);
  const afterObjects = schemaObjects(params.afterUpdate);
  const currentObjects = schemaObjects(params.current);
  const views = (objects: SchemaObject[]) =>
    objects.filter(
      (entry) =>
        entry.type === "view" ||
        (entry.type === "trigger" &&
          !objects.some((table) => table.type === "table" && table.name === entry.tbl_name)),
    );
  if (
    JSON.stringify(views(currentObjects)) !== JSON.stringify(views(afterObjects)) &&
    JSON.stringify(views(currentObjects)) !== JSON.stringify(views(previousObjects))
  ) {
    throw new UpdateCheckpointPreservationUnavailable("views");
  }
  const currentBase = selectUpdateCheckpointSqliteBase(params) === "current";
  const tables = (objects: SchemaObject[]) =>
    objects.filter((entry) => entry.type === "table").map((entry) => entry.name);
  const previousTables = tables(previousObjects),
    currentTables = tables(currentObjects);
  const preservedTables: string[] = [],
    restoredTables: string[] = [];
  const copyRows = new Map<string, Row[]>();
  for (const table of new Set([...previousTables, ...currentTables])) {
    if (table === "update_runs") {
      continue;
    }
    if (table === "schema_meta") {
      const preserveStartup =
        sameSqliteSchema(params.checkpoint, params.afterUpdate) &&
        sameSqliteSchema(params.checkpoint, params.current);
      const currentKeys = new Set(
        readRows(params.current, table)
          .filter(isStartupCheckpoint)
          .map((row) => row.meta_key),
      );
      const strictRows = (db: DatabaseSync) =>
        readRows(db, table).filter(
          (row) =>
            !preserveStartup || !isKnownStartupCheckpoint(row) || !currentKeys.has(row.meta_key),
        );
      if (!rowsEqual(strictRows(params.afterUpdate), strictRows(params.current))) {
        throw new UpdateCheckpointPreservationUnavailable(table);
      }
      copyRows.set(
        table,
        preserveStartup
          ? restoredMetadata(params.checkpoint, params.current)
          : readRows(params.checkpoint, table),
      );
      restoredTables.push(table);
      continue;
    }
    const oldShape = tableShape(previousObjects, table),
      currentShape = tableShape(currentObjects, table);
    if (oldShape === currentShape && previousTables.includes(table)) {
      const definition =
        previousObjects.find((entry) => entry.type === "table" && entry.name === table)?.sql ?? "";
      // Virtual/shadow table mutation requires the extension owner. Equal contents
      // can remain untouched; changed contents cannot be copied with generic SQL.
      const virtual =
        /CREATE\s+VIRTUAL\s+TABLE/iu.test(definition) ||
        readSqliteTableList(params.current).some(
          (row) => row.name === table && row.type === "shadow",
        );
      if (virtual) {
        if (
          currentBase
            ? !rowsMatch(params.current, params.staged, table)
            : !rowsMatch(params.checkpoint, params.current, table)
        ) {
          throw new UpdateCheckpointPreservationUnavailable(table);
        }
      } else {
        if (oldShape !== tableShape(afterObjects, table)) {
          throw new UpdateCheckpointPreservationUnavailable(table);
        }
        copyRows.set(
          table,
          mergeRows(params.checkpoint, params.afterUpdate, params.current, table),
        );
      }
      preservedTables.push(table);
    } else {
      const afterShape = tableShape(afterObjects, table);
      if (
        currentShape !== afterShape ||
        (currentTables.includes(table) && !rowsMatch(params.afterUpdate, params.current, table))
      ) {
        throw new UpdateCheckpointPreservationUnavailable(table);
      }
      restoredTables.push(table);
    }
  }
  // Triggers belong to the checkpoint schema, but must not run during data copy.
  // Foreign-key ordering is validated once the complete coherent state is installed.
  params.staged.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    const triggers = previousObjects.filter((entry) => entry.type === "trigger");
    for (const trigger of triggers) {
      params.staged.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
    }
    for (const [table, rows] of copyRows) {
      const columns = readSqliteTableXInfo(params.staged, table)
        .filter((row) => row.hidden === 0)
        .map((row) => String(row.name));
      if (rowsEqual(rows, readRows(params.staged, table))) {
        continue;
      }
      const rowid = rowIdentityColumn(params.staged, table);
      const insertColumns = rowid ? [rowid, ...columns] : columns;
      params.staged.exec(`DELETE FROM ${quoteIdentifier(table)}`);
      const statement = params.staged.prepare(
        `INSERT INTO ${quoteIdentifier(table)} (${insertColumns.map(quoteIdentifier).join(",")}) VALUES (${insertColumns.map(() => "?").join(",")})`,
      );
      for (const row of rows) {
        statement.run(
          ...(rowid
            ? [row.checkpoint_rowid!, ...columns.map((column) => row[column]!)]
            : columns.map((column) => row[column]!)),
        );
      }
    }
    // AUTOINCREMENT must not reuse identities created and then deleted online.
    const hasSequence = (db: DatabaseSync) => tableExists(db, "sqlite_sequence");
    if (hasSequence(params.current) && hasSequence(params.staged)) {
      const sequence = (db: DatabaseSync, name: string) => {
        if (!hasSequence(db)) {
          return 0n;
        }
        let value: SQLOutputValue = 0n;
        for (const row of iterateSqliteSnapshotTableRows(
          db,
          "sqlite_sequence",
          null,
          "checkpoint_rowid",
        )) {
          if (row.name === name) {
            value = row.seq ?? 0n;
            break;
          }
        }
        if (typeof value !== "bigint") {
          throw new UpdateCheckpointPreservationUnavailable("sqlite_sequence");
        }
        return value;
      };
      for (const table of preservedTables) {
        const previous = sequence(params.checkpoint, table),
          current = sequence(params.current, table),
          staged = sequence(params.staged, table);
        // Undo mutation-owned lowering, retain the online high-water mark and
        // every identity represented by preserved current rows.
        const chosen = current > previous ? current : previous;
        const seq = chosen > staged ? chosen : staged;
        if (seq > 0n) {
          params.staged.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
          params.staged
            .prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)")
            .run(table, seq);
        }
      }
    }
    for (const trigger of triggers) {
      if (trigger.sql) {
        params.staged.exec(trigger.sql);
      }
    }
    const version = Number(params.checkpoint.prepare("PRAGMA user_version").get()?.user_version);
    params.staged.exec(`PRAGMA user_version = ${version}`);
    assertUpdateCheckpointSqliteSchema(params.checkpoint, params.staged, params.current);
    params.staged.exec("COMMIT");
  } catch (error) {
    params.staged.exec("ROLLBACK");
    throw error;
  }
  for (const table of preservedTables) {
    if (
      !rowsEqual(
        copyRows.get(table) ?? readRows(params.current, table),
        readRows(params.staged, table),
      )
    ) {
      throw new UpdateCheckpointPreservationUnavailable(table);
    }
  }
  return { preservedTables, restoredTables };
}
