import { sql, type RawBuilder } from "kysely";
import type { PostgresSqlConnection } from "../sql-connection.js";
import type { SearchSchema, StoreSearchCapabilities } from "./contract.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import {
  assertPostgresSearchAdmitted,
  rebuildPostgresSearch,
  searchConfig,
  pgSearchName,
} from "./postgres-search-schema.js";
import { bindPostgresVector } from "./postgres-vector.js";
import type { TextIndex, TextQuery } from "./text-contract.js";

function tsquery(query: TextQuery, config: string): RawBuilder<unknown> {
  if (query.kind === "contains") {
    throw new Error("Contains is only available on an admitted trigram index");
  }
  if (query.kind !== "term" && query.kind !== "phrase") {
    const clauses = query.clauses.map((clause) => tsquery(clause, config));
    return clauses.length
      ? /* kysely-allow-raw: Only the closed query-kind enum selects an operator. */ sql`(${sql.join(clauses, sql.raw(query.kind === "all" ? " && " : " || "))})`
      : sql`''::tsquery`;
  }
  const parsed =
    query.kind === "term"
      ? sql`plainto_tsquery(${sql.lit(config)}::regconfig, ${query.text})`
      : sql`phraseto_tsquery(${sql.lit(config)}::regconfig, ${query.text})`;
  return query.kind === "phrase" && query.prefix
    ? sql`coalesce((nullif(${parsed}::text, '') || ':*')::tsquery, ''::tsquery)`
    : parsed;
}

export function bindPostgresSearch(
  db: PostgresSqlConnection,
  schema: SearchSchema,
): StoreSearchCapabilities {
  assertPostgresSearchAdmitted(db, schema);
  const config = `${pgSearchName(getPostgresPhysicalFacts(db)!.namespace)}.${pgSearchName(searchConfig)}`;
  const store = {};
  const text = Object.fromEntries(
    Object.entries(schema.text ?? {}).map(([name, index]) => [name, { ...index, store }]),
  );
  const vectors = Object.fromEntries(
    Object.entries(schema.vector ?? {}).map(([name, index]) => [name, { ...index, store }]),
  );
  const relation = (index: TextIndex, field = "openclaw_search") => {
    if (!db.isOpen || index.store !== store) {
      throw new Error("Text index is not admitted to this open store");
    }
    return /* kysely-allow-raw: Identifiers come only from this store's admitted index declaration. */ sql.ref(
      `${index.alias ?? index.table}.${field}`,
    );
  };
  const requireQuery = (query?: TextQuery) => {
    if (!query) {
      throw new Error("PostgreSQL rank and snippet require the literal search query");
    }
    return tsquery(query, config);
  };
  return {
    text,
    vectors,
    diagnostics: [],
    rebuild: () => rebuildPostgresSearch(db, schema),
    fullText: Object.keys(text).length
      ? {
          match(index, query) {
            const column = relation(index);
            if (query.kind === "contains") {
              if (index.postgres?.mode !== "trigram") {
                throw new Error("Contains requires a declared PostgreSQL trigram index");
              }
              const pattern = `%${query.text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
              return /* kysely-allow-raw: PostgreSQL's literal trigram predicate returns boolean. */ sql<boolean>`${relation(index, index.fields[0])} ILIKE ${pattern} ESCAPE '\\'`;
            }
            return /* kysely-allow-raw: PostgreSQL's tsvector predicate returns boolean. */ sql<boolean>`${column} @@ ${tsquery(query, config)}`;
          },
          rank(index, query) {
            const column = relation(index);
            return {
              value: /* kysely-allow-raw: The native rank is a numeric scalar. */ sql<number>`ts_rank_cd(${column}, ${requireQuery(query)}, 2)`,
              order: "desc",
              toRank: (raw) => raw,
            };
          },
          snippet(index, field, maxTokens, query, maxChars = 500) {
            if (maxTokens < 2) {
              throw new Error("PostgreSQL snippets require at least two tokens");
            }
            if (!index.fields.includes(field)) {
              throw new Error(`Text index has no field ${field}`);
            }
            const words = Math.max(1, Math.min(48, Math.trunc(maxTokens)));
            return /* kysely-allow-raw: The native headline is bounded text from the admitted field. */ sql<string>`left(ts_headline(${sql.lit(config)}::regconfig, ${relation(index, field)}, ${requireQuery(query)}, ${`StartSel='', StopSel='', MaxWords=${words}, MinWords=1, MaxFragments=1, FragmentDelimiter=' … '`}), ${Math.max(1, Math.min(500, Math.trunc(maxChars)))})`;
          },
          identity: (index) =>
            /* kysely-allow-raw: The declared source identity is the native numeric row identity. */ sql<number>`${relation(index, index.postgres!.identity)}`,
          allocatedIdentity(index) {
            relation(index);
            throw new Error("PostgreSQL insert identities must use RETURNING");
          },
        }
      : null,
    vector:
      schema.mode === "keyword-only" || !Object.keys(vectors).length
        ? null
        : bindPostgresVector(db, store, schema),
  };
}
