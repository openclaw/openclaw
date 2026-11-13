import type { DatabaseSync } from "node:sqlite";
import { createFunctionModule, sql, type RawBuilder } from "kysely";
import type { FullTextCapability, TextIndex, TextQuery } from "./text-contract.js";

export function sqliteFullTextLiteralQuery(query: TextQuery): string {
  if (query.kind === "contains") {
    throw new Error("Literal contains requires the owner's SQLite substring policy");
  }
  if (query.kind === "term" || query.kind === "phrase") {
    const text =
      query.kind === "term" ? query.text.replaceAll('"', "") : query.text.replaceAll('"', '""');
    return `"${text}"${query.kind === "phrase" && query.prefix ? "*" : ""}`;
  }
  let separator = query.kind === "any" ? " OR " : " AND ";
  if (query.kind === "all" && query.clauses.every((clause) => clause.kind === "phrase")) {
    separator = " ";
  }
  return query.clauses
    .map((clause) =>
      clause.kind === "any"
        ? `(${sqliteFullTextLiteralQuery(clause)})`
        : sqliteFullTextLiteralQuery(clause),
    )
    .join(separator);
}

export function bindSqliteFullText(
  store: object,
  db?: DatabaseSync,
): FullTextCapability & {
  matchBound(index: TextIndex, value: RawBuilder<string>): RawBuilder<boolean>;
} {
  const relation = (index: TextIndex) => {
    if (index.store !== store || (db && !db.isOpen)) {
      throw new Error("Text index is not admitted to this open store");
    }
    return index.alias ?? index.table;
  };
  const match = (index: TextIndex, value: string | RawBuilder<string>) => {
    const table = relation(index);
    return index.matchField
      ? /* kysely-allow-raw: Native MATCH uses the admitted table and field declarations. */ sql<boolean>`${sql.ref(`${table}.${index.matchField}`)} match ${value}`
      : /* kysely-allow-raw: Native MATCH uses the admitted table and fixed rank clause. */ sql<boolean>`${sql.raw(table)} MATCH ${value}${sql.raw(index.hiddenRank ? ` AND ${table}.rank MATCH 'bm25()'` : "")}`;
  };
  return {
    match: (index, query) => match(index, sqliteFullTextLiteralQuery(query)),
    matchBound: match,
    rank(index) {
      const table = relation(index);
      return {
        value: /* kysely-allow-raw: Both native rank forms use the admitted table declaration. */ sql<number>`${sql.raw(index.hiddenRank ? `${table}.rank` : `bm25(${table})`)}`,
        order: "asc",
        toRank: (raw) => (Number.isFinite(raw) ? -raw : 0),
      };
    },
    snippet(index, field, maxTokens) {
      const table = relation(index);
      const column = index.fields.indexOf(field);
      if (column < 0) {
        throw new Error(`Text index has no field ${field}`);
      }
      return /* kysely-allow-raw: Native snippet uses the admitted table, checked field ordinal, and caller token budget. */ sql<string>`${sql.raw(`snippet(${table}, ${column}, '', '', ' … ', ${maxTokens})`)}`;
    },
    identity: (index) =>
      /* kysely-allow-raw: Native row identity uses the admitted index declaration. */ sql<number>`${sql.raw(`${relation(index)}.rowid`)}`,
    allocatedIdentity: (index) => {
      relation(index);
      return /* kysely-allow-raw: FTS insertion identity is connection-local SQLite state. */ sql<number>`${createFunctionModule()<number>("last_insert_rowid", [])}`;
    },
  };
}
