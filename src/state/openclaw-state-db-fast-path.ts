import type { DatabaseSync } from "node:sqlite";
import { readGatewayOwnerLeaseFromDatabase } from "../infra/gateway-owner-lease.read.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { runWithSqliteCleanup } from "../infra/sqlite-lifecycle-errors.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  assertSqliteSchemaContains,
  createSqliteTableContractReader,
  readSqliteSchemaCookie,
  type SqliteTableContractReader,
} from "../infra/sqlite-schema-contract.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { hasLegacyCronRunLogs } from "../infra/state-migrations.cron-run-logs.js";
import { hasUpdateDoctorMigrationCapture } from "../infra/update-doctor-migration-attribution.js";
import { readAgentDatabaseLeaseProvenance } from "./openclaw-agent-db-lease-provenance.js";
import {
  getStateRuntimeSchemaAdmission,
  publishStateRuntimeSchemaAdmission,
} from "./openclaw-state-db-admission.js";
import type { OpenClawStateIntegrityAdmission } from "./openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateRuntimeIntegrity } from "./openclaw-state-db-integrity-admission.js";
import { assertOpenClawStateDatabaseForMaintenance } from "./openclaw-state-db-maintenance.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import { assertCanonicalStateSchemaShape } from "./openclaw-state-db-schema-repair.js";
import {
  admitStateSchemaFacts,
  assertSupportedStateSchemaVersion,
  readStateSchemaContentVersion,
} from "./openclaw-state-db-schema-version.js";
import { STATE_RUNTIME_SCHEMA_COMPATIBILITY } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export function needsOpenClawStateDatabaseSchemaRepair(
  pathname: string,
  scope: "automatic" | "doctor" = "automatic",
  integrityCheck: "quick" | "full" = "quick",
): boolean {
  let database: DatabaseSync | undefined;
  let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSync> | undefined;
  try {
    // A native source read can reset the captured WAL index before migration takes custody.
    prepared = hasUpdateDoctorMigrationCapture()
      ? prepareSqliteReadOnlyLocationSync(pathname)
      : undefined;
    database = openNodeSqliteDatabase(prepared?.location ?? pathname, { readOnly: true });
    if (scope === "automatic" && getStateRuntimeSchemaAdmission(database)?.startupReady) {
      return false;
    }
    admitStateSchemaFacts(database, pathname);
    assertSupportedStateSchemaVersion(database, pathname);
    const needsRepair =
      readStateSchemaContentVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION ||
      hasLegacyCronRunLogs(database);
    if (!needsRepair) {
      assertCurrentStateRuntimeSchema(database, pathname);
      if (scope === "doctor") {
        assertSqliteIntegrity(database, pathname, { check: integrityCheck });
      }
    }
    return needsRepair;
  } catch {
    // Preserve the repair path's existing diagnostics for unreadable or noncanonical databases.
    return true;
  } finally {
    runWithSqliteCleanup({ release: () => prepared?.cleanup() }, "State schema inspection", () =>
      database?.close(),
    );
  }
}

export function assertCurrentStateRuntimeSchema(
  database: DatabaseSync,
  pathname: string,
  readTable: SqliteTableContractReader = createSqliteTableContractReader(database),
): void {
  assertCanonicalStateSchemaShape(database, pathname);
  assertOpenClawStateDatabaseForMaintenance(database, { pathname }, readTable);
  assertSqliteSchemaContains(
    database,
    pathname,
    OPENCLAW_STATE_SCHEMA_SQL,
    STATE_RUNTIME_SCHEMA_COMPATIBILITY,
    readTable,
  );
}

/** Catalog presence is enough to refuse retired history without reading or rewriting its rows. */
export function assertNoLegacyStateRuntimeRepair(database: DatabaseSync, pathname: string): void {
  if (hasLegacyCronRunLogs(database)) {
    throw new OpenClawStateDatabaseSchemaMigrationRequiredError("legacy-cron-run-logs", pathname);
  }
}

export function isOpenClawStateSchemaFastPathEligible(
  database: DatabaseSync,
  pathname: string,
  integrity?: OpenClawStateIntegrityAdmission,
): boolean {
  const admitted = getStateRuntimeSchemaAdmission(database);
  if (admitted) {
    return admitted.startupReady;
  }
  let publishIntegrity: (() => void) | undefined;
  const eligible = withSqlitePostCommitPublications(database, () =>
    runSqliteDeferredTransactionSync(
      database,
      () => {
        const userVersion = assertSupportedStateSchemaVersion(database, pathname);
        if (readStateSchemaContentVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION) {
          return false;
        }
        const schemaVersion = readSqliteSchemaCookie(database);
        if (typeof schemaVersion !== "number") {
          throw new Error(`Shared-state database ${pathname} schema version is unavailable.`);
        }
        // Repair must collect fresh facts after this read transaction ends.
        const readTable = createSqliteTableContractReader(database);
        assertCurrentStateRuntimeSchema(database, pathname, readTable);
        assertNoLegacyStateRuntimeRepair(database, pathname);
        const owner = readGatewayOwnerLeaseFromDatabase(database);
        const liveGatewayOwner =
          owner?.state === "live" &&
          owner.pid !== process.pid &&
          Boolean(owner.stateDatabaseProvenance) &&
          owner.stateDatabaseProvenance === readAgentDatabaseLeaseProvenance(pathname);
        // Trust the live Gateway's exact-file ownership; borrowers record no verification or seal.
        if (!liveGatewayOwner) {
          publishIntegrity = assertOpenClawStateRuntimeIntegrity(
            database,
            pathname,
            { schemaVersion, userVersion },
            integrity,
          );
        }
        return true;
      },
      { operationLabel: "state.admission.fast-path" },
    ),
  );
  publishIntegrity?.();
  if (eligible) {
    publishStateRuntimeSchemaAdmission(database, true);
  }
  return eligible;
}
