import type pg from "pg";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";

export function installPostgresStateFixture(connection: string, schemaPrefix: string) {
  installDatabaseEngineSelection({
    effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
    postgres: { connection, schemaPrefix },
  });
}

export async function cleanupPostgresStateFixture(
  client: pg.Client,
  pathname: string,
  namespace: string | undefined,
) {
  retireSqliteDatabaseAdmissionForPath(pathname);
  resetDatabaseEngineSelectionForTest();
  try {
    if (namespace) {
      await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
    }
  } finally {
    await client.end();
  }
}
