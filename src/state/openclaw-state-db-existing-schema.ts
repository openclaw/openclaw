import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  createSqliteTableContractReader,
  readSqliteSchemaCookie,
} from "../infra/sqlite-schema-contract.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { OpenClawStateIntegrityAdmission } from "./openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  assertCurrentStateRuntimeSchema,
  assertNoLegacyStateRuntimeRepair,
} from "./openclaw-state-db-fast-path.js";
import {
  assertOpenClawStateRuntimeIntegrity,
  type OpenClawStateIntegrityPolicy,
} from "./openclaw-state-db-integrity-admission.js";
import { classifySqliteTableReadError } from "./openclaw-state-db-schema-helpers.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaMigrationVersion,
} from "./openclaw-state-db-schema-version.js";
import type { DB } from "./openclaw-state-db.generated.js";

const validatedSchemas = new WeakMap<DatabaseSync, { cookie: number; unregister: () => void }>();

/** Recheck mutable metadata within the caller's admission transaction. */
export function assertExistingOpenClawStateRuntimeMetadata(
  database: DatabaseSync,
  pathname: string,
): number {
  const version = assertSupportedStateSchemaVersion(database, pathname);
  if (readStateSchemaMigrationVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Existing shared-state database ${pathname} requires schema migration by its owning installation; run openclaw doctor --fix there before using it.`,
    );
  }
  let metadata;
  try {
    metadata = executeSqliteQueryTakeFirstSync(
      database,
      getNodeSqliteKysely<Pick<DB, "schema_meta">>(database)
        .selectFrom("schema_meta")
        .select(["role", "schema_version"])
        .where("meta_key", "=", "primary")
        .limit(1),
    );
  } catch (error) {
    throw classifySqliteTableReadError(
      database,
      "schema_meta",
      ["meta_key", "role", "schema_version"],
      error,
    );
  }
  if (metadata?.role !== "global" || metadata.schema_version !== version) {
    throw new Error(
      `Existing shared-state database ${pathname} has inconsistent ownership or schema metadata.`,
    );
  }
  return version;
}

/** Prove the existing runtime contract without certifying this release's repairs. */
export function assertExistingOpenClawStateRuntimeSchema(
  database: DatabaseSync,
  pathname: string,
  integrity?: OpenClawStateIntegrityAdmission,
  integrityPolicy?: OpenClawStateIntegrityPolicy,
): void {
  let publishIntegrity: (() => void) | undefined;
  const schemaCookie = runSqliteDeferredTransactionSync(
    database,
    () => {
      const userVersion = assertExistingOpenClawStateRuntimeMetadata(database, pathname);
      const currentCookie = readSqliteSchemaCookie(database);
      if (typeof currentCookie !== "number") {
        throw new Error(
          `Existing shared-state database ${pathname} schema version is unavailable.`,
        );
      }
      const cached = validatedSchemas.get(database);
      if (cached?.cookie !== currentCookie) {
        cached?.unregister();
        validatedSchemas.delete(database);
      }
      if (cached?.cookie !== currentCookie || integrityPolicy === "require-proof") {
        publishIntegrity = assertOpenClawStateRuntimeIntegrity(
          database,
          pathname,
          { schemaVersion: currentCookie, userVersion },
          integrity,
          integrityPolicy,
        );
      }
      if (cached?.cookie !== currentCookie) {
        const readTable = createSqliteTableContractReader(database);
        assertCurrentStateRuntimeSchema(database, pathname, readTable);
        assertNoLegacyStateRuntimeRepair(database, pathname);
      }
      return currentCookie;
    },
    { operationLabel: "state.admission.existing-schema" },
  );
  publishIntegrity?.();
  // Transactional DDL can roll back and reuse its cookie for another schema.
  if (!database.isTransaction && validatedSchemas.get(database)?.cookie !== schemaCookie) {
    const unregister = registerNodeSqliteDisposeCallback(database, () => {
      validatedSchemas.delete(database);
      unregister();
    });
    validatedSchemas.set(database, { cookie: schemaCookie, unregister });
  }
}
