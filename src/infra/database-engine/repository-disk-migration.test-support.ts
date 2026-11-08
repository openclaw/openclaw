import type { Client } from "pg";
import { expect } from "vitest";
import {
  ensureStatePostgresFragment,
  stateEngineSchema,
} from "../../state/openclaw-state-db-engine.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { StoreSchema } from "./contract.js";
import { openEngineStore } from "./open.js";

export async function assertRepositoryDiskMigration(params: {
  present: boolean;
  client: Pick<Client, "query">;
  connection: string;
  namespace: string;
  pathname: string;
  prepareSource: (schema: StoreSchema) => Promise<void>;
  runDoctor: (version: number) => Promise<{ warnings: readonly string[] }>;
}) {
  const { present, client, connection, namespace, pathname, prepareSource, runDoctor } = params;
  const sourceSchema: StoreSchema = {
    ...stateEngineSchema,
    ...stateEngineSchema.postgresMigrations!.find((migration) => migration.version === 38)!
      .fromSchema,
    version: 37,
  };
  await prepareSource(sourceSchema);
  if (present) {
    withEngineStoreAdmission(() => {
      using anchor = openNodeSqliteDatabase(pathname);
      const db = openEngineStore({
        anchor,
        schema: sourceSchema,
        input: { connection, schemaPrefix: "doctor_fixture" },
        inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: true }),
        prepareAnchor() {},
        openSqlite() {
          throw new Error("Expected PostgreSQL");
        },
        existingOnly: true,
      });
      try {
        if (!isPostgresSqlConnection(db)) {
          throw new Error("Expected PostgreSQL");
        }
        db.runTransaction(() => ensureStatePostgresFragment(db, "session_repository_workspaces"));
      } finally {
        db.close();
      }
    });
    await client.query(
      'INSERT INTO "' +
        namespace +
        '".session_repository_workspaces (workspace_id, agent_id, session_key, url, branch, revision, created_at_ms, updated_at_ms) VALUES ($1, $2, $3, $4, $5, 3, 1, 1)',
      [
        "00000000-0000-4000-8000-000000000001",
        "main",
        "repository",
        "https://example.invalid/repository.git",
        "branch",
      ],
    );
  }
  expect((await runDoctor(37)).warnings).toEqual([]);
  if (present) {
    expect(
      (
        await client.query(
          'SELECT revision, disk_authority_json FROM "' +
            namespace +
            '".session_repository_workspaces',
        )
      ).rows,
    ).toEqual([{ revision: "3", disk_authority_json: null }]);
  } else {
    expect(
      (
        await client.query("SELECT to_regclass($1) AS relation", [
          namespace + ".session_repository_workspaces",
        ])
      ).rows,
    ).toEqual([{ relation: null }]);
  }
}
