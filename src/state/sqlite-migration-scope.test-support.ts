import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { foldSqliteIdentifierCase, quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";

type TableSnapshot = { schema: string; content: string };

function captureUndeclaredTables(
  database: DatabaseSync,
  declaredTables: ReadonlySet<string>,
): Map<string, TableSnapshot> {
  const objects = database
    .prepare(
      `SELECT type, name, tbl_name, sql FROM main.sqlite_schema
       WHERE type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name`,
    )
    .all();
  const tables = database
    .prepare(
      `SELECT name, wr FROM pragma_table_list
       WHERE schema = 'main' AND type IN ('table', 'virtual', 'shadow')
         AND name != 'sqlite_schema'`,
    )
    .all();
  const snapshots = new Map<string, TableSnapshot>();
  // Table scopes cannot restore views, including views over declared tables.
  for (const object of objects.filter((entry) => entry.type === "view")) {
    snapshots.set(String(object.name), {
      schema: JSON.stringify(
        objects.filter(
          (entry) =>
            foldSqliteIdentifierCase(String(entry.tbl_name)) ===
            foldSqliteIdentifierCase(String(object.name)),
        ),
      ),
      content: "",
    });
  }
  for (const table of tables) {
    const name = String(table.name);
    if (declaredTables.has(name)) {
      continue;
    }
    const columns = database
      .prepare(`PRAGMA main.table_xinfo(${quoteSqliteIdentifier(name)})`)
      .all()
      .filter((column) => column.hidden !== 1);
    const names = columns.map((column) => String(column.name));
    let order: string[];
    if (table.wr === 1) {
      order = columns
        .filter((column) => Number(column.pk) > 0)
        .toSorted((left, right) => Number(left.pk) - Number(right.pk))
        .map((column) => String(column.name));
    } else {
      const rowid = ["rowid", "_rowid_", "oid"].find(
        (alias) => !names.some((column) => column.toLowerCase() === alias),
      );
      if (!rowid) {
        throw new Error(`Cannot prove migration scope: ${name} hides every implicit rowid alias`);
      }
      names.unshift(rowid);
      order = [rowid];
    }
    const selections = names.flatMap((column, index) => {
      const quoted = quoteSqliteIdentifier(column);
      return [
        `typeof(${quoted}) AS type_${index}`,
        // Preserve storage classes, integer precision, embedded NULs and raw BLOB bytes.
        `CASE typeof(${quoted})
           WHEN 'integer' THEN CAST(${quoted} AS TEXT)
           WHEN 'real' THEN printf('%!.26g', ${quoted})
           WHEN 'text' THEN CAST(${quoted} AS BLOB)
           ELSE ${quoted} END AS value_${index}`,
      ];
    });
    const hash = createHash("sha256").update(JSON.stringify(names));
    const rows = database.prepare(
      `SELECT ${selections.join(", ")} FROM main.${quoteSqliteIdentifier(name)}
       ORDER BY ${order.map(quoteSqliteIdentifier).join(", ")}`,
    );
    for (const row of rows.iterate()) {
      for (let index = 0; index < names.length; index++) {
        const value = row[`value_${index}`];
        if (value !== null && typeof value !== "string" && !(value instanceof Uint8Array)) {
          throw new Error(`Cannot encode migration scope witness for ${name}.${names[index]}`);
        }
        const bytes =
          value === null ? Buffer.alloc(0) : typeof value === "string" ? Buffer.from(value) : value;
        hash
          .update(`${String(row[`type_${index}`])}:${bytes.byteLength}:`)
          .update(bytes)
          .update(";");
      }
      hash.update("\n");
    }
    snapshots.set(name, {
      schema: JSON.stringify(
        objects.filter(
          (object) =>
            foldSqliteIdentifierCase(String(object.tbl_name)) === foldSqliteIdentifierCase(name),
        ),
      ),
      content: hash.digest("hex"),
    });
  }
  return snapshots;
}

/** Run the owning migration, including its finalizer; callers declare metadata tables too. */
export async function assertSqliteMigrationScopePreserved<T>(
  database: DatabaseSync,
  declaredTables: readonly string[],
  migrate: () => T | Promise<T>,
): Promise<T> {
  const scope = new Set(declaredTables);
  const before = captureUndeclaredTables(database, scope);
  const result = await migrate();
  const after = captureUndeclaredTables(database, scope);
  const changes: string[] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const original = before.get(name);
    const current = after.get(name);
    if (!original || !current) {
      changes.push(`${name}: ${original ? "removed" : "created"}`);
    } else {
      if (original.schema !== current.schema) {
        changes.push(`${name}: schema changed`);
      }
      if (original.content !== current.content) {
        changes.push(`${name}: content changed`);
      }
    }
  }
  if (changes.length > 0) {
    throw new Error(`Migration changed undeclared tables:\n${changes.toSorted().join("\n")}`);
  }
  return result;
}
