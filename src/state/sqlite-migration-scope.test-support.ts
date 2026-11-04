import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  foldSqliteIdentifierCase as fold,
  quoteSqliteIdentifier as quote,
} from "../infra/sqlite-schema-sql.js";

function captureUndeclaredTables(database: DatabaseSync, declaredTables: ReadonlySet<string>) {
  const all = (sql: string) => database.prepare(sql).all();
  const objects = all(`
    SELECT type, name, tbl_name, sql FROM main.sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name
  `);
  const tables = all(`
    SELECT name, wr FROM pragma_table_list
    WHERE schema = 'main' AND type IN ('table', 'virtual', 'shadow') AND name != 'sqlite_schema'
  `);
  const snapshots = new Map<string, { schema: string; content: string }>();
  const schemaFor = (name: string) =>
    JSON.stringify(objects.filter((object) => fold(String(object.tbl_name)) === fold(name)));
  // Table scopes cannot restore views, including views over declared tables.
  for (const object of objects.filter((entry) => entry.type === "view")) {
    snapshots.set(String(object.name), { schema: schemaFor(String(object.name)), content: "" });
  }
  for (const table of tables) {
    const name = String(table.name);
    if (declaredTables.has(name)) {
      continue;
    }
    const xinfo = all(`PRAGMA main.table_xinfo(${quote(name)})`);
    const columns = xinfo.filter(({ hidden }) => hidden !== 1);
    const names = columns.map((column) => String(column.name));
    const rowidAliases = ["rowid", "_rowid_", "oid"];
    const rowid =
      table.wr === 1
        ? undefined
        : rowidAliases.find((alias) => !names.some((column) => column.toLowerCase() === alias));
    if (table.wr !== 1 && !rowid) {
      throw new Error(`Cannot prove migration scope: ${name} hides every implicit rowid alias`);
    }
    if (rowid) {
      names.unshift(rowid);
    }
    const order = rowid
      ? [rowid]
      : columns
          .filter((column) => Number(column.pk) > 0)
          .toSorted((left, right) => Number(left.pk) - Number(right.pk))
          .map((column) => String(column.name));
    // Preserve storage classes, integer precision, embedded NULs and raw BLOB bytes.
    const selections = names.map((column, index) => {
      const quoted = quote(column);
      return `typeof(${quoted}) AS type_${index}, CASE typeof(${quoted})
           WHEN 'integer' THEN CAST(${quoted} AS TEXT)
           WHEN 'real' THEN printf('%!.26g', ${quoted})
           WHEN 'text' THEN CAST(${quoted} AS BLOB)
           ELSE ${quoted} END AS value_${index}`;
    });
    const hash = createHash("sha256").update(JSON.stringify(names));
    const rows = database.prepare(
      `SELECT ${selections.join(", ")} FROM main.${quote(name)} ORDER BY ${order.map(quote).join(", ")}`,
    );
    for (const row of rows.iterate()) {
      for (let index = 0; index < names.length; index++) {
        const value = row[`value_${index}`];
        if (value !== null && typeof value !== "string" && !(value instanceof Uint8Array)) {
          throw new Error(`Cannot encode migration scope witness for ${name}.${names[index]}`);
        }
        const bytes = typeof value === "string" ? Buffer.from(value) : (value ?? Buffer.alloc(0));
        const header = `${String(row[`type_${index}`])}:${bytes.byteLength}:`;
        hash.update(header).update(bytes).update(";");
      }
      hash.update("\n");
    }
    snapshots.set(name, { schema: schemaFor(name), content: hash.digest("hex") });
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
  const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap((name) => {
    const [original, current] = [before.get(name), after.get(name)];
    if (!original || !current) {
      return [`${name}: ${original ? "removed" : "created"}`];
    }
    return (["schema", "content"] as const)
      .filter((field) => original[field] !== current[field])
      .map((field) => `${name}: ${field} changed`);
  });
  if (changes.length > 0) {
    throw new Error(`Migration changed undeclared tables:\n${changes.toSorted().join("\n")}`);
  }
  return result;
}
