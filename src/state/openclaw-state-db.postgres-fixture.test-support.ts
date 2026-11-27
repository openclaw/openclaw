import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { expect } from "vitest";
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

export function readPostgresStateFixtureArtifacts(directory: string, pathname: string) {
  const credentialPath = path.join(directory, "client", "credentials.sqlite");
  expect([
    fs.readdirSync(directory).toSorted(),
    fs.readdirSync(path.dirname(pathname)).toSorted(),
    fs.readdirSync(path.dirname(credentialPath)).toSorted(),
  ]).toEqual([["client", "state"], ["openclaw.sqlite"], ["credentials.sqlite"]]);
  return [fs.readFileSync(pathname), fs.readFileSync(credentialPath)];
}
