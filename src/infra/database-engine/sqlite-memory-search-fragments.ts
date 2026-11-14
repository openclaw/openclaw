import { readGeneratedSqliteFingerprint } from "../../state/postgres-schema.generated/sqlite-catalogs.js";
import type { SqliteSchemaCatalog } from "../sqlite-schema-catalog-types.js";
import {
  fingerprintSqliteSchemaCatalog,
  type GeneratedSqliteFingerprint,
} from "../sqlite-schema-fingerprint.js";
import { normalizeSchemaSql } from "../sqlite-schema-sql.js";

type TextFragment = {
  kind: "body-fts" | "path-fts";
  tableName: string;
  tokenizer: "unicode61" | "trigram";
};
type SqliteMemorySearchFragment =
  | TextFragment
  | { kind: "vector"; tableName: string; dimensions: number };

function buildTextSchema(fragment: TextFragment, tokenizeClause: string): string {
  if (fragment.kind === "body-fts") {
    return (
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${fragment.tableName} USING fts5(\n` +
      `  text,\n` +
      `  id UNINDEXED,\n` +
      `  path UNINDEXED,\n` +
      `  source UNINDEXED,\n` +
      `  model UNINDEXED,\n` +
      `  start_line UNINDEXED,\n` +
      `  end_line UNINDEXED\n` +
      `${tokenizeClause});`
    );
  }
  return `
      CREATE VIRTUAL TABLE IF NOT EXISTS ${fragment.tableName} USING fts5(
        path,
        source UNINDEXED
        ${tokenizeClause}
      );
    `;
}

function tokenizerClause(tokenizer: TextFragment["tokenizer"]): string {
  return tokenizer === "trigram" ? `, tokenize='trigram case_sensitive 0'` : "";
}

export function buildSqliteMemoryBodyFtsSchema(params: Omit<TextFragment, "kind">): string {
  return buildTextSchema({ ...params, kind: "body-fts" }, tokenizerClause(params.tokenizer));
}

export function buildSqliteMemoryPathFtsSchema(params: {
  tokenizer: TextFragment["tokenizer"];
  tableName?: string;
}): string {
  return buildTextSchema(
    { ...params, kind: "path-fts", tableName: params.tableName ?? "memory_index_paths_fts" },
    tokenizerClause(params.tokenizer),
  );
}

export function buildSqliteMemoryVectorSchema(params: {
  tableName: string;
  dimensions: number;
  ifNotExists?: boolean;
}): string {
  return (
    `CREATE VIRTUAL TABLE${params.ifNotExists ? " IF NOT EXISTS" : ""} ${params.tableName} USING vec0(\n` +
    `  id TEXT PRIMARY KEY,\n  embedding FLOAT[${params.dimensions}]\n)`
  );
}

function fragmentSql(fragment: SqliteMemorySearchFragment): string {
  return fragment.kind === "vector"
    ? buildSqliteMemoryVectorSchema(fragment)
    : buildTextSchema(fragment, tokenizerClause(fragment.tokenizer));
}

function templateFragment(fragment: SqliteMemorySearchFragment): SqliteMemorySearchFragment {
  return fragment.kind === "vector"
    ? { kind: "vector", tableName: "memory_index_chunks_vec", dimensions: 1 }
    : {
        ...fragment,
        tableName:
          fragment.kind === "body-fts" ? "memory_index_chunks_fts" : "memory_index_paths_fts",
      };
}

/** Include deployed explicit-unicode spellings as well as current lazy FTS schemas. */
export function getSqliteMemorySearchFtsSchemas(): string[] {
  return (["body-fts", "path-fts"] as const).flatMap((kind) => {
    const fragment = templateFragment({ kind, tableName: "", tokenizer: "unicode61" });
    if (fragment.kind === "vector") {
      return [];
    }
    return [
      buildTextSchema(fragment, ""),
      buildTextSchema(fragment, ", tokenize='unicode61'"),
      buildTextSchema(fragment, ', tokenize="unicode61"'),
      buildTextSchema(fragment, tokenizerClause("trigram")),
    ];
  });
}

/** One generated hash per fragment; dimensions and custom names belong to the owner's receipt. */
export function getSqliteMemorySearchFragmentFingerprint(
  fragment: SqliteMemorySearchFragment,
): GeneratedSqliteFingerprint {
  const descriptor = readGeneratedSqliteFingerprint(fragmentSql(templateFragment(fragment)));
  if (!descriptor) {
    throw new Error("Memory search schema has no generated fingerprint; run pnpm db:postgres:gen.");
  }
  return descriptor;
}

/** Native facts are supplied by admission; this comparison never executes or inspects a database. */
export function matchesSqliteMemorySearchFragment(
  catalog: SqliteSchemaCatalog,
  fragment: SqliteMemorySearchFragment,
): boolean {
  const parent = catalog.tables.find((table) => table.name === fragment.tableName);
  const actualSql = parent && normalizeSchemaSql(parent.sql);
  const expectedSql = normalizeSchemaSql(fragmentSql(fragment));
  const explicitUnicode =
    actualSql !== expectedSql &&
    fragment.kind !== "vector" &&
    fragment.tokenizer === "unicode61" &&
    (["'", '"'] as const).some(
      (quote) =>
        actualSql ===
        normalizeSchemaSql(buildTextSchema(fragment, `, tokenize=${quote}unicode61${quote}`)),
    );
  if (!parent || (actualSql !== expectedSql && !explicitUnicode)) {
    return false;
  }
  const template = templateFragment(fragment);
  const descriptor = getSqliteMemorySearchFragmentFingerprint(fragment);
  const canonicalParentSql = normalizeSchemaSql(fragmentSql(template));
  if (fragment.tableName === template.tableName) {
    return (
      fingerprintSqliteSchemaCatalog(
        {
          ...catalog,
          tables: catalog.tables.map((table) =>
            table === parent ? { ...table, sql: canonicalParentSql } : table,
          ),
        },
        descriptor,
      ) === descriptor.fingerprint
    );
  }
  const ownsName = (name: string) =>
    name === fragment.tableName || name.startsWith(`${fragment.tableName}_`);
  const rename = (name: string) => template.tableName + name.slice(fragment.tableName.length);
  const actual = {
    views: catalog.views,
    tables: catalog.tables
      .filter((table) => ownsName(table.name))
      .map((table) => {
        const name = rename(table.name);
        return {
          name,
          strict: table.strict,
          withoutRowid: table.withoutRowid,
          foreignKeys: table.foreignKeys,
          triggers: table.triggers,
          // Native extension declarations quote only the shadow-table identifier; preserve all other text.
          sql:
            table === parent
              ? canonicalParentSql
              : (table.sql
                  ?.replace(`CREATE TABLE '${table.name}'`, `CREATE TABLE '${name}'`)
                  .replace(`CREATE TABLE "${table.name}"`, `CREATE TABLE "${name}"`) ?? null),
          columns: table.columns.map((column) =>
            column.hidden && column.name === fragment.tableName
              ? { ...column, name: template.tableName }
              : column,
          ),
          indexes: table.indexes.map((index) =>
            index.name.startsWith(`sqlite_autoindex_${fragment.tableName}_`)
              ? {
                  ...index,
                  name: `sqlite_autoindex_${rename(index.name.slice("sqlite_autoindex_".length))}`,
                }
              : index,
          ),
        };
      }),
  };
  return fingerprintSqliteSchemaCatalog(actual, descriptor) === descriptor.fingerprint;
}
