import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  createSqliteTableContractReader,
  readSqliteSchemaCookie,
} from "../infra/sqlite-schema-contract.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  getStateRuntimeSchemaAdmission,
  getStateSchemaVersionAdmission,
  publishStateRuntimeSchemaAdmission,
} from "./openclaw-state-db-admission.js";
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
  readStateSchemaContentVersion,
} from "./openclaw-state-db-schema-version.js";
import type { DB } from "./openclaw-state-db.generated.js";

/** Metadata is validated with the physical database's first runtime admission. */
function assertExistingOpenClawStateRuntimeMetadata(
  database: DatabaseSync,
  pathname: string,
): number {
  if (getStateRuntimeSchemaAdmission(database)) {
    const version = getStateSchemaVersionAdmission(database)?.userVersion;
    if (version !== undefined) {
      return version;
    }
  }
  const version = assertSupportedStateSchemaVersion(database, pathname);
  if (readStateSchemaContentVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION) {
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

/** Validate an existing runtime schema without applying repairs. */
export function assertExistingOpenClawStateRuntimeSchema(
  database: DatabaseSync,
  pathname: string,
  integrity?: OpenClawStateIntegrityAdmission,
  integrityPolicy?: OpenClawStateIntegrityPolicy,
): void {
  const admitted = getStateRuntimeSchemaAdmission(database)
    ? getAdmittedSqliteSchemaFacts(database)
    : undefined;
  if (admitted) {
    // Every warm handle must retain revocation custody for the integrity proof it borrows.
    assertOpenClawStateRuntimeIntegrity(
      database,
      pathname,
      admitted,
      integrity,
      integrityPolicy,
    )?.();
    return;
  }
  let publishIntegrity: (() => void) | undefined;
  runSqliteDeferredTransactionSync(
    database,
    () => {
      const userVersion = assertExistingOpenClawStateRuntimeMetadata(database, pathname);
      const currentCookie = readSqliteSchemaCookie(database);
      if (typeof currentCookie !== "number") {
        throw new Error(
          `Existing shared-state database ${pathname} schema version is unavailable.`,
        );
      }
      publishIntegrity = assertOpenClawStateRuntimeIntegrity(
        database,
        pathname,
        { schemaVersion: currentCookie, userVersion },
        integrity,
        integrityPolicy,
      );
      const readTable = createSqliteTableContractReader(database);
      assertCurrentStateRuntimeSchema(database, pathname, readTable);
      assertNoLegacyStateRuntimeRepair(database, pathname);
    },
    { operationLabel: "state.admission.existing-schema" },
  );
  publishIntegrity?.();
  publishStateRuntimeSchemaAdmission(database, true);
}
