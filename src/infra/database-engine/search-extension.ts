import {
  isPostgresSqlConnection,
  type EngineConnection,
  type PostgresSqlConnection,
} from "../sql-connection.js";
import {
  invalidateLocalSqliteSchemaAdmissions,
  publishSqliteDatabaseSchemaChange,
} from "../sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../sqlite-post-commit.js";
import type { SearchSchema } from "./contract.js";
import { getPostgresPhysicalFacts, publishPostgresSearchExtensionFacts } from "./physical-facts.js";
import {
  getAdmittedPostgresSchema,
  retainPostgresSchema,
  verifyAndRecordPostgresSchema,
} from "./postgres-schema.js";
import {
  admitPostgresSearch,
  postgresSearchSql,
  publishPostgresSearch,
} from "./postgres-search-schema.js";
import { bindStoreSearch } from "./search.js";
import { admitSqliteMemoryVectorSearch } from "./sqlite-memory-vector-schema.js";
import { admitSqliteMemoryTextSearch } from "./sqlite-search-schema.js";

class SearchExtensionDefinitionChangedError extends Error {
  override name = "SearchExtensionDefinitionChangedError";
}

/** Definition preflight only; binding still checks the store's search capability admission. */
export function arePostgresSearchExtensionsAdmitted(
  db: PostgresSqlConnection,
  definitions: Readonly<Record<string, SearchSchema>>,
): boolean {
  const schema = getAdmittedPostgresSchema(db);
  return Boolean(
    schema &&
    getPostgresPhysicalFacts(db) &&
    Object.entries(definitions).every(
      ([name, definition]) =>
        JSON.stringify(schema.searchExtensions?.[name]) === JSON.stringify(definition),
    ),
  );
}

/** Register only at the owner's admission boundary; SQLite retains its existing derived lifecycle. */
export function admitStoreSearchExtension(
  db: EngineConnection,
  name: string,
  definition: SearchSchema,
) {
  if (!isPostgresSqlConnection(db)) {
    if (name === "memory.vector") {
      admitSqliteMemoryVectorSearch(db, definition);
    }
    return bindStoreSearch(
      db,
      name === "memory.text" ? admitSqliteMemoryTextSearch(db, definition) : definition,
    );
  }
  const base = getAdmittedPostgresSchema(db);
  const facts = getPostgresPhysicalFacts(db);
  if (!base || !facts) {
    throw new Error("Search extensions require an admitted PostgreSQL store");
  }
  if (JSON.stringify(base.searchExtensions?.[name]) === JSON.stringify(definition)) {
    return bindStoreSearch(db, definition);
  }
  if (base.searchExtensions?.[name]) {
    throw new SearchExtensionDefinitionChangedError(
      `Search extension ${name} changed. Restore its previous definition, or rebuild the derived extension from canonical source data before using the new definition.`,
    );
  }
  db.runTransaction(() => {
    admitPostgresSearch(db, definition, facts.namespace, base.postgresVectorSearchVersion);
    const existing = [base.search, ...Object.values(base.searchExtensions ?? {})].filter(
      (item) => item !== undefined,
    );
    if (
      existing.some(
        (item) => (item.extensionSchema ?? "public") !== (definition.extensionSchema ?? "public"),
      )
    ) {
      throw new Error("Search extensions must use the store's admitted extension schema");
    }
    const next = {
      ...base,
      searchExtensions: { ...base.searchExtensions, [name]: definition },
    };
    db.exec(
      postgresSearchSql(
        definition,
        facts.namespace,
        {
          text: existing.some((item) => Object.keys(item.text ?? {}).length > 0),
          vector: existing.some(
            (item) => item.mode !== "keyword-only" && Object.keys(item.vector ?? {}).length > 0,
          ),
        },
        base.postgresVectorDecoderVersion,
        base.postgresVectorSearchVersion,
      ),
    );
    if (!Object.keys(base.searchExtensions ?? {}).length) {
      // sqlite-allow-raw: Engine-owned metadata is outside the application catalog seal.
      db.exec("ALTER TABLE openclaw_schema_meta ADD COLUMN IF NOT EXISTS search_extensions TEXT");
    }
    // sqlite-allow-raw: Persist only the admitted owner's definitions, in the same DDL transaction.
    db.prepare("UPDATE openclaw_schema_meta SET search_extensions = ? WHERE store = ?").run(
      JSON.stringify(next.searchExtensions),
      base.id,
    );
    const after = verifyAndRecordPostgresSchema(db, facts.namespace, next);
    invalidateLocalSqliteSchemaAdmissions(db);
    stageSqliteTransactionState(db, {
      commit: () => publishSqliteDatabaseSchemaChange(db),
    });
    // Publish the new revision before its facts; admission owns rollback too.
    retainPostgresSchema(db, next);
    publishPostgresSearchExtensionFacts(db, facts, after.catalog);
    for (const item of [next.search, ...Object.values(next.searchExtensions)].filter(
      (candidate) => candidate !== undefined,
    )) {
      publishPostgresSearch(db, item, base.postgresVectorSearchVersion);
    }
  });
  return bindStoreSearch(db, definition);
}
