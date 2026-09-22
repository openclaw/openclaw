import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import {
  assertSqliteSchemaContains,
  readSqliteSchemaCookie,
} from "../infra/sqlite-schema-contract.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  assertCurrentStateRuntimeSchema,
  assertNoLegacyStateRuntimeRepair,
} from "./openclaw-state-db-fast-path.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaMigrationVersion,
} from "./openclaw-state-db-schema-version.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  getOpenClawStateRuntimeSchema,
  STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";

const validatedSchemas = new WeakMap<DatabaseSync, { cookie: number; unregister: () => void }>();

/** Prove the existing runtime contract without certifying this release's repairs. */
export function assertExistingOpenClawStateRuntimeSchema(
  database: DatabaseSync,
  pathname: string,
): void {
  const schemaCookie = runSqliteDeferredTransactionSync(database, () => {
    const version = assertSupportedStateSchemaVersion(database, pathname);
    if (readStateSchemaMigrationVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION) {
      throw new Error(
        `Existing shared-state database ${pathname} requires schema migration by its owning installation before this node can use it.`,
      );
    }
    const metadata = executeSqliteQueryTakeFirstSync(
      database,
      getNodeSqliteKysely<Pick<DB, "schema_meta">>(database)
        .selectFrom("schema_meta")
        .select(["role", "schema_version"])
        .where("meta_key", "=", "primary")
        .limit(1),
    );
    if (metadata?.role !== "global" || metadata.schema_version !== version) {
      throw new Error(
        `Existing shared-state database ${pathname} has inconsistent ownership or schema metadata.`,
      );
    }
    const currentCookie = readSqliteSchemaCookie(database);
    if (typeof currentCookie !== "number") {
      throw new Error(`Existing shared-state database ${pathname} schema version is unavailable.`);
    }
    const cached = validatedSchemas.get(database);
    if (cached?.cookie !== currentCookie) {
      cached?.unregister();
      validatedSchemas.delete(database);
      assertSqliteIntegrity(database, pathname);
      assertCurrentStateRuntimeSchema(database, pathname);
      assertNoLegacyStateRuntimeRepair(database, pathname);
      assertSqliteSchemaContains(
        database,
        pathname,
        getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
        STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
      );
    }
    return currentCookie;
  });
  // Transactional DDL can roll back and reuse its cookie for another schema.
  if (!database.isTransaction && validatedSchemas.get(database)?.cookie !== schemaCookie) {
    const unregister = registerNodeSqliteDisposeCallback(database, () => {
      validatedSchemas.delete(database);
      unregister();
    });
    validatedSchemas.set(database, { cookie: schemaCookie, unregister });
  }
}
