import type { DatabaseSync } from "node:sqlite";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../../infra/sqlite-schema-facts.js";
import { quoteSqliteIdentifier } from "../../infra/sqlite-schema-sql.js";

/**
 * Capture and restore of everything a tombstone reclaim deletes for one
 * placeholder.
 *
 * Deleting a `session_windows` row does not only remove that row: every table
 * holding transcript state hangs off it through `ON DELETE CASCADE`, directly
 * (`transcript_events`, `session_conversations`, ...) or transitively
 * (`transcript_event_identities`, `session_transcript_active_events`). A
 * snapshot that captured only `session_nodes` and `session_windows` could put
 * the placeholder's shell back while leaving its conversation events gone, so
 * a sweep that reported the candidate as restored would have silently dropped
 * its history.
 *
 * The cascade is therefore read from the live schema rather than from a list
 * maintained here: `PRAGMA foreign_key_list` is walked outward from
 * `session_windows`, so a table added to the cascade later is captured without
 * anyone remembering to update this file, and a cascade shape this code cannot
 * express fails loudly instead of quietly restoring less than it removed.
 *
 * That walk is schema work, so it is resolved once per admitted schema rather
 * than once per placeholder: the table list comes from the connection's
 * admitted schema facts, and the derived cascade description is retained
 * against that facts object. The schema owner replaces the object whenever it
 * invalidates — DDL, a foreign commit, a rollback, physical replacement — so
 * the description cannot outlive the schema it describes, and a backlog of
 * placeholders no longer repeats the whole walk per candidate.
 *
 * The one thing deliberately NOT captured is the derived transcript search
 * index: `session_transcript_fts_rows` carries no foreign key (its owner,
 * `deleteSessionTranscriptIndexInTransaction`, deletes it explicitly) and the
 * FTS5 content table behind it is maintained by a delete-only trigger, so
 * re-inserting projection rows would leave the index desynchronized rather
 * than rebuilt. Restored generations are marked for reconcile instead, which
 * is the index owner's own repair path.
 */

/** A table reachable from `session_windows` through `ON DELETE CASCADE`. */
type CascadeTable = {
  name: string;
  /** Column carrying the session id this table's rows belong to. */
  sessionIdColumn: string;
};

const ROOT_TABLE = "session_windows";
const ROOT_SESSION_ID_COLUMN = "session_id";

/**
 * Cascade descriptions keyed by the admitted schema facts they were derived
 * from.
 *
 * The schema owner hands out one facts object per schema generation and
 * replaces it on every invalidation, so keying on the object itself is the
 * invalidation lifecycle — there is no separate expiry to maintain here and no
 * way to read a description that outlived its schema. Weak so a retired
 * connection's facts do not pin their cascade.
 */
const cascadeTablesBySchema = new WeakMap<SqliteSchemaFacts, CascadeTable[]>();

/**
 * One column of an untyped SQLite row, required to be text.
 *
 * The string admission itself is the shared `readStringValue` seam; what this
 * adds is the refusal. Every caller is reading a schema identifier it is about
 * to interpolate into SQL or replay into a table, so a missing or non-text
 * value cannot be defaulted away — it has to stop the snapshot.
 */
function requireSchemaText(row: Record<string, unknown>, column: string): string {
  const value = readStringValue(row[column]);
  if (value === undefined) {
    throw new Error(`SQLite schema walk expected a string ${column}`);
  }
  return value;
}

/** Foreign keys of `table`, grouped so composite keys stay one constraint. */
function readForeignKeyGroups(
  database: DatabaseSync,
  table: string,
): { parent: string; onDelete: string; columns: { from: string; to: string }[] }[] {
  const rows = /* sqlite-allow-raw: foreign-key introspection has no Kysely form. */ database
    .prepare(`PRAGMA foreign_key_list(${quoteSqliteIdentifier(table)})`)
    // SAFETY: node:sqlite hands back untyped rows; the assertion types every column as `unknown`, so it grants no value type -- `requireSchemaText` is the only thing that admits one, and every other column is replayed verbatim into the table it came from.
    .all() as Record<string, unknown>[];
  const groups = new Map<
    number,
    { parent: string; onDelete: string; columns: { from: string; to: string }[] }
  >();
  for (const row of rows) {
    const id = row.id;
    if (typeof id !== "number") {
      throw new Error(`SQLite returned a non-numeric foreign-key id for ${table}`);
    }
    const group = groups.get(id) ?? {
      parent: requireSchemaText(row, "table"),
      onDelete: requireSchemaText(row, "on_delete").toUpperCase(),
      columns: [],
    };
    // A composite key reports its parent column as NULL when it targets the
    // parent's primary key implicitly; such a key cannot be followed by name.
    group.columns.push({
      from: requireSchemaText(row, "from"),
      to: typeof row.to === "string" ? row.to : "",
    });
    groups.set(id, group);
  }
  return [...groups.values()];
}

/**
 * Tables that a `session_windows` delete cascades into, parents before
 * children so a restore can replay them in insertion order.
 */
function walkSessionWindowCascadeTables(
  database: DatabaseSync,
  tables: readonly string[],
): CascadeTable[] {
  const sessionIdColumnByTable = new Map<string, string>([[ROOT_TABLE, ROOT_SESSION_ID_COLUMN]]);
  const ordered: CascadeTable[] = [];
  let frontier = [ROOT_TABLE];
  // Bounded by the number of tables: each pass admits at least one new child
  // or stops, so a cycle cannot spin here.
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const table of tables) {
      if (sessionIdColumnByTable.has(table)) {
        continue;
      }
      for (const group of readForeignKeyGroups(database, table)) {
        if (group.onDelete !== "CASCADE" || !frontier.includes(group.parent)) {
          continue;
        }
        const parentSessionIdColumn = sessionIdColumnByTable.get(group.parent);
        const link = group.columns.find((column) => column.to === parentSessionIdColumn);
        if (!link) {
          // A cascade this walk cannot follow would be captured as nothing and
          // silently lost on restore, which is the exact failure this module
          // exists to prevent.
          throw new Error(
            `Tombstone snapshot cannot follow the ${table} cascade from ${group.parent}`,
          );
        }
        sessionIdColumnByTable.set(table, link.from);
        ordered.push({ name: table, sessionIdColumn: link.from });
        next.push(table);
        break;
      }
    }
    frontier = next;
  }
  return ordered;
}

/**
 * Tables that a `session_windows` delete cascades into, resolved once per
 * admitted schema generation.
 *
 * Admitted facts are required rather than optional: the alternative is to fall
 * back to querying `sqlite_schema` per call, which is the per-candidate schema
 * walk this exists to remove, and a snapshot taken against schema facts nobody
 * admitted is exactly the case where restoring less than the delete removed
 * would go unnoticed.
 */
function resolveSessionWindowCascadeTables(database: DatabaseSync): CascadeTable[] {
  const schema = getAdmittedSqliteSchemaFacts(database);
  if (!schema) {
    throw new Error("Tombstone snapshot cascade resolution requires admitted schema facts");
  }
  let cascade = cascadeTablesBySchema.get(schema);
  if (!cascade) {
    cascade = walkSessionWindowCascadeTables(database, [...schema.tables]);
    cascadeTablesBySchema.set(schema, cascade);
  }
  return cascade;
}

/**
 * A candidate's full `session_nodes` row, every `session_windows` row it owns,
 * and every cascading row those windows own, read inside the transaction that
 * is about to remove them and before it does.
 *
 * `SELECT *` rather than a named column list deliberately: a snapshot that only
 * knew the columns this file cares about would restore an incomplete row if the
 * schema has grown columns since, silently dropping data on the one path meant
 * to put it back exactly as found.
 */
export type ReclaimedRowSnapshot = {
  sessionKey: string;
  node: Record<string, unknown>;
  windows: Record<string, unknown>[];
  /** Cascading rows, parents first, as `[table, rows]` in replay order. */
  cascaded: { table: string; rows: Record<string, unknown>[] }[];
  /** Window session ids the snapshot covers. */
  sessionIds: string[];
};

function selectRowsBySessionId(
  database: DatabaseSync,
  table: string,
  column: string,
  sessionIds: readonly string[],
): Record<string, unknown>[] {
  const placeholders = sessionIds.map(() => "?").join(", ");
  return (
    /* sqlite-allow-raw: the table is resolved from the live cascade, outside the generated Kysely types. */ database
      .prepare(
        `SELECT * FROM ${quoteSqliteIdentifier(table)} WHERE ${quoteSqliteIdentifier(column)} IN (${placeholders})`,
      )
      // SAFETY: node:sqlite hands back untyped rows; the assertion types every column as `unknown`, so it grants no value type -- `requireSchemaText` is the only thing that admits one, and every other column is replayed verbatim into the table it came from.
      .all(...sessionIds) as Record<string, unknown>[]
  );
}

export function captureReclaimedRowSnapshot(
  database: DatabaseSync,
  sessionKey: string,
): ReclaimedRowSnapshot | undefined {
  const node =
    /* sqlite-allow-raw: paired with the dynamic cascade reads below so one snapshot is taken through one statement style. */ database
      .prepare("SELECT * FROM session_nodes WHERE session_key = ?")
      // SAFETY: node:sqlite hands back untyped rows; the assertion types every column as `unknown`, so it grants no value type -- `requireSchemaText` is the only thing that admits one, and every other column is replayed verbatim into the table it came from.
      .get(sessionKey) as Record<string, unknown> | undefined;
  if (!node) {
    return undefined;
  }
  const windows = /* sqlite-allow-raw: see above. */ database
    .prepare("SELECT * FROM session_windows WHERE session_key = ?")
    // SAFETY: node:sqlite hands back untyped rows; the assertion types every column as `unknown`, so it grants no value type -- `requireSchemaText` is the only thing that admits one, and every other column is replayed verbatim into the table it came from.
    .all(sessionKey) as Record<string, unknown>[];
  const sessionIds = windows.map((window) => requireSchemaText(window, ROOT_SESSION_ID_COLUMN));
  const cascaded: { table: string; rows: Record<string, unknown>[] }[] = [];
  if (sessionIds.length > 0) {
    for (const table of resolveSessionWindowCascadeTables(database)) {
      const rows = selectRowsBySessionId(database, table.name, table.sessionIdColumn, sessionIds);
      if (rows.length > 0) {
        cascaded.push({ table: table.name, rows });
      }
    }
  }
  return { sessionKey, node, windows, cascaded, sessionIds };
}

function insertRows(
  database: DatabaseSync,
  table: string,
  rows: readonly Record<string, unknown>[],
): void {
  for (const row of rows) {
    const columns = Object.keys(row);
    if (columns.length === 0) {
      continue;
    }
    // INSERT OR IGNORE keeps a restore idempotent against a row something else
    // already put back, matching the conflict handling the node/window restore
    // has always used.
    /* sqlite-allow-raw: the table is resolved from the live cascade, outside the generated Kysely types. */ database
      .prepare(
        `INSERT OR IGNORE INTO ${quoteSqliteIdentifier(table)} (${columns
          .map((column) => quoteSqliteIdentifier(column))
          .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      // SAFETY: `run` binds only SQLite-representable values, and each one came out of `all()`/`get()` on this same database, so it round-trips unchanged; `never` only silences the untyped bind signature.
      .run(...columns.map((column) => row[column] as never));
  }
}

/**
 * Re-inserts a reclaim's own recovery preimage, undoing that reclaim's delete.
 *
 * Rows are replayed outward from the placeholder — node, then windows, then
 * each cascading table in the order the schema walk discovered it — so every
 * foreign key has its parent present by the time a child row lands. The caller
 * runs this inside the store's write transaction; nothing here opens one,
 * because a half-applied restore is worse than a failed one.
 */
export function restoreReclaimedRowSnapshot(
  database: DatabaseSync,
  snapshot: ReclaimedRowSnapshot,
): void {
  insertRows(database, "session_nodes", [snapshot.node]);
  insertRows(database, ROOT_TABLE, snapshot.windows);
  for (const { table, rows } of snapshot.cascaded) {
    insertRows(database, table, rows);
  }
}
