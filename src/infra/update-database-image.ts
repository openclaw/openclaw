import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  quoteSqliteIdentifier,
  normalizeSqlWhitespace,
  normalizeSqlIdentifier,
  readSqlToken,
} from "./sqlite-schema-sql.js";

function imageHasher(domain: string) {
  const hash = createHash("sha256").update(domain);
  return {
    add: (value: unknown) => {
      const serialized = JSON.stringify(value);
      hash
        .update(String(Buffer.byteLength(serialized)))
        .update(":")
        .update(serialized);
    },
    finish: () => hash.digest("hex"),
  };
}

function encode(value: SQLOutputValue): unknown {
  if (value instanceof Uint8Array) {
    return ["bytes", Buffer.from(value).toString("hex")];
  }
  if (typeof value === "bigint") {
    return ["integer", value.toString()];
  }
  if (typeof value === "number") {
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(value);
    return ["real", bytes.toString("hex")];
  }
  return value;
}

function hasStoredVirtualImage(sql: unknown): boolean {
  if (typeof sql !== "string") {
    return false;
  }
  const normalized = normalizeSqlWhitespace(sql);
  let offset = 0;
  for (const keyword of ["CREATE", "VIRTUAL", "TABLE"]) {
    const token = readSqlToken(normalized, offset);
    if (token?.keyword !== keyword) {
      return false;
    }
    offset = token.end;
  }
  let table = readSqlToken(normalized, offset);
  if (table?.keyword === "IF") {
    const not = readSqlToken(normalized, table.end);
    const exists = not ? readSqlToken(normalized, not.end) : null;
    if (not?.keyword !== "NOT" || exists?.keyword !== "EXISTS") {
      return false;
    }
    table = readSqlToken(normalized, exists.end);
  }
  const using = table ? readSqlToken(normalized, table.end) : null;
  const module = using ? readSqlToken(normalized, using.end) : null;
  return (
    using?.keyword === "USING" &&
    module !== null &&
    ["fts3", "fts4", "fts5", "rtree", "rtree_i32"].includes(normalizeSqlIdentifier(module.raw))
  );
}

function readPersistentSetting(database: DatabaseSync, pragma: string, column = pragma) {
  const value =
    // sqlite-allow-raw -- Native persistent-header metadata belongs to the exact recovery image.
    database.prepare("PRAGMA main." + pragma).get()?.[column];
  if (pragma === "encoding") {
    if (value === "UTF-8" || value === "UTF-16le" || value === "UTF-16be") {
      return value;
    }
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  // SQLite silently ignores unavailable PRAGMAs. Unknown metadata cannot
  // establish an unchanged image, including builds omitting deprecated PRAGMAs.
  throw new Error("Database image cannot verify persistent setting: " + pragma);
}

/** Exact SQL image, not physical layout: checkpoints and native close may move
 * committed WAL pages without changing stored values. Retain the caller's native
 * transaction; never open/close a second source handle. Only update-time receipt
 * observers and isolated inspection workers pay this scan. */
export function readUpdateDatabaseImage(database: DatabaseSync): string {
  if (!database.isTransaction) {
    throw new Error("Database image evidence requires its native transaction");
  }
  const { add, finish } = imageHasher("openclaw-update-data-image-v1");
  const lease = imageHasher("openclaw-update-leases-image-v1");
  const schema =
    // sqlite-allow-raw -- Preserve schema SQL bytes independently of the application schema.
    database
      .prepare(
        "SELECT type, name, tbl_name, sql, hex(CAST(sql AS BLOB)) AS sql_bytes FROM main.sqlite_schema ORDER BY type COLLATE BINARY, name COLLATE BINARY",
      )
      .all();
  // Empty schema is not empty state: persistent metadata still belongs to
  // its writer. Only the exclusive creation owner may account for absence.
  add([
    "openclaw-update-sql-image-v1",
    readPersistentSetting(database, "user_version"),
    readPersistentSetting(database, "application_id"),
    readPersistentSetting(database, "schema_version"),
    readPersistentSetting(database, "page_size"),
    readPersistentSetting(database, "auto_vacuum"),
    readPersistentSetting(database, "encoding"),
    // Unlike connection-local cache_size, this is the durable header setting.
    // SQLite returns it in cache_size; never read source bytes under writer locks.
    readPersistentSetting(database, "default_cache_size", "cache_size"),
  ]);
  add(schema);
  const tables =
    // sqlite-allow-raw -- Native table kinds identify shadow tables and unsupported virtual modules.
    database
      .prepare("PRAGMA main.table_list")
      .all()
      .filter(
        (table) =>
          table.schema === "main" && table.type !== "view" && table.name !== "sqlite_schema",
      )
      .toSorted((left, right) =>
        String(left.name) < String(right.name)
          ? -1
          : String(left.name) > String(right.name)
            ? 1
            : 0,
      );
  for (const table of tables) {
    if (typeof table.name !== "string") {
      throw new Error("Database image has an unnamed table");
    }
    if (table.type === "virtual") {
      const sql = schema.find((entry) => entry.name === table.name)?.sql;
      // Built-in virtual indexes store their image in included shadow tables.
      // Unknown external modules cannot supply complete restore evidence.
      if (!hasStoredVirtualImage(sql)) {
        throw new Error("Database image cannot verify an external virtual table");
      }
      continue;
    }
    if (table.type !== "table" && table.type !== "shadow") {
      throw new Error("Unsupported database image table kind");
    }
    addTableImage(
      database,
      table.name,
      table.wr === 1,
      table.name === "state_leases" ? lease.add : add,
    );
  }
  return finish() + ":" + lease.finish();
}

function addTableImage(
  database: DatabaseSync,
  tableName: string,
  withoutRowid: boolean,
  add: (value: unknown) => void,
): void {
  const quoted = quoteSqliteIdentifier(tableName);
  const columns =
    // sqlite-allow-raw -- Native metadata preserves hidden-column and physical-rowid semantics.
    database
      .prepare("PRAGMA main.table_xinfo(" + quoted + ")")
      .all()
      .filter((column) => column.hidden !== 1);
  const names = columns.map((column) => {
    if (typeof column.name !== "string") {
      throw new Error("Database image has an unnamed column");
    }
    return column.name;
  });
  const declared = new Set(names.map((name) => name.toLowerCase()));
  const rowid = withoutRowid
    ? undefined
    : ["_rowid_", "rowid", "oid"].find((name) => !declared.has(name));
  if (!withoutRowid && !rowid) {
    throw new Error("Database image cannot verify shadowed rowids");
  }
  const values = [...(rowid ? [rowid] : []), ...names].map(quoteSqliteIdentifier);
  const key = rowid
    ? [rowid]
    : columns
        .filter((column) => Number(column.pk) > 0)
        .toSorted((left, right) => Number(left.pk) - Number(right.pk))
        .map((column) => String(column.name));
  if (key.length === 0) {
    throw new Error("Database image has no stable row order");
  }
  // Preserve undecodable TEXT bytes and distinguish them from BLOB values.
  const selection = values
    .flatMap((value, index) => [
      "typeof(" + value + ") AS t" + index,
      "CASE typeof(" +
        value +
        ") WHEN 'text' THEN CAST(" +
        value +
        " AS BLOB) ELSE " +
        value +
        " END AS v" +
        index,
    ])
    .join(",");
  const statement =
    // sqlite-allow-raw -- Schema-independent images require native bigint reads and original TEXT bytes.
    database.prepare(
      "SELECT " +
        selection +
        " FROM main." +
        quoted +
        " NOT INDEXED ORDER BY " +
        key.map((name) => quoteSqliteIdentifier(name) + " COLLATE BINARY").join(","),
    );
  statement.setReadBigInts(true);
  add([tableName, values]);
  for (const row of statement.iterate()) {
    add(Object.values(row).map(encode));
  }
  add(["end-table"]);
}

/** The heartbeat owner changes only state_leases. Keep that table as a separate
 * exact image, not an ignored/volatile field: foreign changes to ANY lease row
 * must still have a complete before/after chain at Doctor settlement. */
export function readUpdateDatabaseLeaseImage(database: DatabaseSync): string {
  if (!database.isTransaction) {
    throw new Error("Lease image requires its native transaction");
  }
  const hash = imageHasher("openclaw-update-leases-image-v1");
  const table =
    // sqlite-allow-raw -- Inspect native table kind before hashing the separate lease image.
    database
      .prepare("PRAGMA main.table_list")
      .all()
      .find((entry) => entry.schema === "main" && entry.name === "state_leases");
  if (table) {
    if (table.type !== "table") {
      throw new Error("Lease image requires an ordinary table");
    }
    addTableImage(database, "state_leases", table.wr === 1, hash.add);
  }
  return hash.finish();
}
