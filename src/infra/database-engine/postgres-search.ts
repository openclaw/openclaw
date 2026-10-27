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
    if (query.clauses.every((clause) => clause.kind === "term" || clause.kind === "phrase")) {
      // Bind a flat query once. Thousands of literal atoms must not expand the
      // SQL expression tree before PostgreSQL can apply its text-search parser.
      const separator = query.kind === "all" ? " & " : " | ";
      return /* kysely-allow-raw: The recordset contains bound literals; only the closed query-kind selects conjunction. */ sql`coalesce((
        SELECT string_agg('(' || nullif(parsed.value::text, '') ||
          CASE WHEN atom.prefix THEN ':*' ELSE '' END || ')', ${separator})
        FROM json_to_recordset(${JSON.stringify(query.clauses)}::json)
          AS atom(kind text, text text, prefix boolean)
        CROSS JOIN LATERAL (SELECT CASE WHEN atom.kind = 'term'
          THEN plainto_tsquery(${sql.lit(config)}::regconfig, atom.text)
          ELSE phraseto_tsquery(${sql.lit(config)}::regconfig, atom.text)
        END AS value) AS parsed
      ), '')::tsquery`;
    }
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
  const extension = pgSearchName(schema.extensionSchema ?? "public");
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
            const column = relation(index, query.kind === "contains" ? index.fields[0] : undefined);
            // Long intent prompts can exceed PostgreSQL's tsquery tree limit.
            // Ordinary queries keep the indexable single-tsquery predicate.
            if (
              query.kind === "any" &&
              query.clauses.length > 128 &&
              query.clauses.every(
                (clause): clause is Extract<TextQuery, { kind: "phrase" }> =>
                  clause.kind === "phrase" && !clause.prefix,
              )
            ) {
              const phrases = query.clauses.map((clause) => clause.text);
              return /* kysely-allow-raw: Bound literal phrases are matched independently against the admitted vector. */ sql<boolean>`EXISTS (SELECT 1 FROM json_array_elements_text(${JSON.stringify(phrases)}::json) AS search_terms(value) WHERE ${column} @@ phraseto_tsquery(${sql.lit(config)}::regconfig, search_terms.value))`;
            }
            if (query.kind === "contains") {
              if (index.postgres?.mode !== "trigram") {
                throw new Error("Contains requires a declared PostgreSQL trigram index");
              }
              const pattern = `%${query.text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
              return /* kysely-allow-raw: PostgreSQL's literal trigram predicate returns boolean. */ sql<boolean>`${column} ILIKE ${pattern} ESCAPE '\\'`;
            }
            return /* kysely-allow-raw: PostgreSQL's tsvector predicate returns boolean. */ sql<boolean>`${column} @@ ${tsquery(query, config)}`;
          },
          rank(index, query, options) {
            if (query?.kind === "contains") {
              if (index.postgres?.mode !== "trigram") {
                throw new Error("Contains requires a declared PostgreSQL trigram index");
              }
              return {
                value: /* kysely-allow-raw: The admitted extension ranks a bound literal against its declared field. */ sql<number>`${sql.raw(extension)}.word_similarity(${query.text}, ${relation(index, index.fields[0])})`,
                order: "desc",
                toRank: (raw) => raw,
              };
            }
            const column = relation(index);
            const rankFunction =
              options?.postgres?.rank === "frequency" ? sql`ts_rank` : sql`ts_rank_cd`;
            return {
              value: /* kysely-allow-raw: The closed rank choice selects a native numeric function. */ sql<number>`${rankFunction}(${column}, ${requireQuery(query)}, ${options?.postgres?.normalization ?? 2})`,
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
          allocatedIdentity() {
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
