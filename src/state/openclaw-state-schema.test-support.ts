import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { captureFreshDoctorMigrationTables } from "../commands/doctor-migration-backup.js";
import { CLIENT_CREDENTIAL_LEGACY_TABLES_SQL } from "../infra/client-credential-schema.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { runWithDoctorMigrationBackup } from "../infra/update-doctor-migration-attribution.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { FIRST_USE_STATE_TABLES } from "./openclaw-state-db-contract.js";
import { repairOpenClawStateDatabaseSchema } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { createSqliteSchemaShapeFromSql } from "./sqlite-schema-shape.test-support.js";

/** Current catalogs omit the credential tables retained by every pre-cutover source. */
export function addPreCutoverClientCredentialTablesForTest(
  database: Pick<DatabaseSync, "exec">,
): void {
  database.exec(CLIENT_CREDENTIAL_LEGACY_TABLES_SQL);
}

/** Historical schema success paths retain the real owner and Doctor's fresh table backup. */
export async function withStateMigrationBackupForTest<T>(
  options: OpenClawStateDatabaseOptions,
  operation: () => T,
): Promise<Awaited<T>> {
  const pathname = options.path ?? resolveOpenClawStateSqlitePath(options.env);
  const lease = acquireGatewayStateOwner({ databasePath: pathname });
  const resources = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: lease.assertCurrent,
    assertDatabaseAccess: lease.assertDatabaseAccess,
  });
  try {
    // Retain asynchronous work in the resource scope until process custody is released.
    return await resources.run(() =>
      runWithDoctorMigrationBackup(captureFreshDoctorMigrationTables, operation),
    );
  } finally {
    await resources.close();
    lease.release();
  }
}

export function createInitialStateSchemaShape(
  deletionJournal: "present" | "unavailable" = "present",
) {
  const shape = createSqliteSchemaShapeFromSql(
    new URL("./openclaw-state-schema.sql", import.meta.url),
  );
  for (const tableName of FIRST_USE_STATE_TABLES) {
    delete shape[tableName];
  }
  if (deletionJournal === "unavailable") {
    delete shape.agent_deletion_journal;
  }
  return shape;
}

export async function expectStateSchemaRepair(
  options: NonNullable<Parameters<typeof repairOpenClawStateDatabaseSchema>[0]>,
  changes: unknown[],
  warnings: unknown[] = [],
) {
  expect(
    await withStateMigrationBackupForTest(options, () =>
      repairOpenClawStateDatabaseSchema(options),
    ),
  ).toEqual({ changes, warnings });
}
