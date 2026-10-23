import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { SqliteSchemaCatalog } from "./sqlite-schema-catalog-types.js";
import { normalizeSchemaSql } from "./sqlite-schema-sql.js";

export type SqliteSchemaSelection = {
  readonly tableNames: readonly string[];
  readonly viewNames: readonly string[];
  readonly indexNames: readonly string[];
};

export type GeneratedSqliteFingerprint = SqliteSchemaSelection & {
  readonly id: string;
  readonly fingerprint: string;
};

/** Hash native facts, retaining expression text rather than interpreting SQL expressions. */
export function fingerprintSqliteSchemaCatalog(
  catalog: SqliteSchemaCatalog,
  selection?: SqliteSchemaSelection,
): string {
  const tableNames = selection && new Set(selection.tableNames);
  const viewNames = selection && new Set(selection.viewNames);
  const indexNames = selection && new Set(selection.indexNames);
  const triggers = (rows: SqliteSchemaCatalog["views"][number]["triggers"]) =>
    rows.map(({ name, sql }) => ({ name, sql: normalizeSchemaSql(sql) })).toSorted(byName);
  const columns = (rows: SqliteSchemaCatalog["views"][number]["columns"]) =>
    rows
      .map(({ cid, name, type, notnull, dflt_value, pk, hidden }) => ({
        cid,
        name,
        type,
        notnull,
        dflt_value,
        pk,
        hidden,
      }))
      .toSorted((left, right) => left.cid - right.cid);
  const facts = {
    tables: catalog.tables
      .filter((table) => !tableNames || tableNames.has(table.name))
      .map((table) => ({
        name: table.name,
        sql: normalizeSchemaSql(table.sql),
        strict: table.strict,
        withoutRowid: table.withoutRowid,
        columns: columns(table.columns),
        foreignKeys: table.foreignKeys
          .map(({ id, seq, table: targetTable, from, to, on_update, on_delete, match }) => ({
            id,
            seq,
            table: targetTable,
            from,
            to,
            on_update,
            on_delete,
            match,
          }))
          .toSorted((left, right) => left.id - right.id || left.seq - right.seq),
        indexes: table.indexes
          // Extra ordinary indexes are compatible; extra uniqueness is not.
          .filter((index) => !indexNames || index.unique === 1 || indexNames.has(index.name))
          .map((index) => ({
            name: index.name,
            origin: index.origin,
            partial: index.partial,
            unique: index.unique,
            sql: normalizeSchemaSql(index.sql),
            terms: index.terms
              .map(({ seqno, cid, name, desc, coll, key }) => ({
                seqno,
                cid,
                name,
                desc,
                coll,
                key,
              }))
              .toSorted((left, right) => left.seqno - right.seqno),
          }))
          .toSorted(byName),
        triggers: triggers(table.triggers),
      }))
      .toSorted(byName),
    views: catalog.views
      .filter((view) => !viewNames || viewNames.has(view.name))
      .map((view) => ({
        name: view.name,
        sql: normalizeSchemaSql(view.sql),
        columns: columns(view.columns),
        triggers: triggers(view.triggers),
      }))
      .toSorted(byName),
  };
  return sha256Hex(JSON.stringify(facts));
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}
