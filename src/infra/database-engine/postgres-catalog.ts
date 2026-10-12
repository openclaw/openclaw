import { isDeepStrictEqual } from "node:util";

export type PostgresCatalogFact = { table: string; kind: string; value: unknown };
export type PostgresCatalogSource = {
  schema: string;
  tables: readonly {
    name: string;
    columns: readonly {
      name: string;
      type: string;
      nullable: boolean;
      identity: boolean;
      default: string | null;
    }[];
    pk: readonly string[];
    unique: readonly (readonly string[])[];
    foreignKeys: readonly {
      columns: string[];
      target: string;
      targetColumns: string[];
      onUpdate: string;
      onDelete: string;
      deferred: boolean;
      deferrable: boolean;
    }[];
    indexes: number;
  }[];
  objects: readonly { table: string; kind: string; sql: string | null; category?: string }[];
};

/** Generation and runtime admission compare the same portable schema contract. */
export function expectedPostgresCatalog(data: PostgresCatalogSource): PostgresCatalogFact[] {
  const expected: PostgresCatalogFact[] = [];
  const add = (table: string, kind: string, value: unknown) =>
    expected.push({ table, kind, value });
  for (const table of data.tables) {
    add(table.name, "table", null);
    table.columns.forEach((column, position) =>
      add(table.name, "column", { ...column, position: position + 1 }),
    );
    if (table.pk.length) {
      add(table.name, "primaryKey", table.pk);
    }
    table.unique.forEach((key) => add(table.name, "unique", key));
    table.foreignKeys.forEach((key) => add(table.name, "foreignKey", key));
    const objects = data.objects.filter((item) => item.table === table.name);
    add(
      table.name,
      "indexes",
      data.schema.endsWith("_state")
        ? objects.filter((item) => item.kind === "index" && item.category !== "pendingPromotion")
            .length + (table.columns.some((column) => column.identity) ? 1 : 0)
        : table.indexes,
    );
    add(
      table.name,
      "checks",
      objects.filter(
        (item) => item.kind === "check" && (data.schema.endsWith("_state") || item.sql),
      ).length,
    );
  }
  return expected;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b, "en")))
      : item,
  );
}

export function assertPostgresCatalog(
  actual: readonly PostgresCatalogFact[],
  expected: readonly PostgresCatalogFact[],
): void {
  if (!isDeepStrictEqual(actual.map(canonical).toSorted(), expected.map(canonical).toSorted())) {
    throw new Error(
      "PostgreSQL catalog differs from its generated contract; use the matching OpenClaw version or restore the matching PostgreSQL schema and anchor.",
    );
  }
}

export function readPostgresCatalog(value: unknown): PostgresCatalogFact[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item): item is PostgresCatalogFact =>
        item !== null &&
        typeof item === "object" &&
        typeof item.table === "string" &&
        typeof item.kind === "string" &&
        "value" in item,
    )
  ) {
    throw new Error("PostgreSQL did not return catalog facts");
  }
  return value;
}

/** One statement gives every catalog fact the same PostgreSQL MVCC snapshot. */
export function postgresCatalogQuery(namespace: string, includeDefinitions = false): string {
  const literal = `'${namespace.replaceAll("'", "''")}'`;
  const columns = (relation: string, keys: string) =>
    `(SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM unnest(${keys}) WITH ORDINALITY k(num, ordinality) JOIN pg_catalog.pg_attribute a ON a.attrelid = ${relation} AND a.attnum = k.num)`;
  const action = (field: string) =>
    `CASE ${field} WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END`;
  return `WITH relations AS (
    SELECT c.oid, c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${literal} AND c.relkind IN ('r', 'p')
  ), facts AS (
    SELECT r.relname AS "table", 'table' AS kind, 'null'::jsonb AS value FROM relations r
    UNION ALL SELECT r.relname, 'column', jsonb_build_object(
      'name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
      'nullable', NOT a.attnotnull, 'identity', a.attidentity = 'd', 'position', a.attnum,
      'default', regexp_replace(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '::(text|bigint|double precision)$', ''))
      FROM relations r JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum WHERE a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT r.relname, CASE c.contype WHEN 'p' THEN 'primaryKey' ELSE 'unique' END,
      ${columns("r.oid", "c.conkey")} FROM relations r JOIN pg_catalog.pg_constraint c ON c.conrelid = r.oid WHERE c.contype IN ('p', 'u')
    UNION ALL SELECT r.relname, 'foreignKey', jsonb_build_object(
      'columns', ${columns("r.oid", "c.conkey")}, 'target', target.relname,
      'targetColumns', ${columns("c.confrelid", "c.confkey")},
      'onUpdate', ${action("c.confupdtype")}, 'onDelete', ${action("c.confdeltype")},
      'deferrable', c.condeferrable, 'deferred', c.condeferred)
      FROM relations r JOIN pg_catalog.pg_constraint c ON c.conrelid = r.oid
      JOIN pg_catalog.pg_class target ON target.oid = c.confrelid WHERE c.contype = 'f'
    UNION ALL SELECT r.relname, 'indexes', to_jsonb((SELECT count(*) FROM pg_catalog.pg_index i WHERE i.indrelid = r.oid)) FROM relations r
    UNION ALL SELECT r.relname, 'checks', to_jsonb((SELECT count(*) FROM pg_catalog.pg_constraint c WHERE c.conrelid = r.oid AND c.contype = 'c')) FROM relations r
    ${
      includeDefinitions
        ? `UNION ALL SELECT r.relname, 'constraintDefinition', jsonb_build_object('name', c.conname, 'definition', pg_catalog.pg_get_constraintdef(c.oid)) FROM relations r JOIN pg_catalog.pg_constraint c ON c.conrelid = r.oid
    UNION ALL SELECT r.relname, 'indexDefinition', jsonb_build_object('name', c.relname, 'definition', pg_catalog.pg_get_indexdef(i.indexrelid), 'valid', i.indisvalid) FROM relations r JOIN pg_catalog.pg_index i ON i.indrelid = r.oid JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid`
        : ""
    }
  ) SELECT coalesce(jsonb_agg(facts), '[]'::jsonb) AS catalog FROM facts`;
}
