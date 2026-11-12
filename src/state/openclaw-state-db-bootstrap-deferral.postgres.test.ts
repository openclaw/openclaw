import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { openPostgresEngineTestStore } from "../infra/database-engine/engine-store.test-support.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import {
  openExistingStatePostgresConnection,
  stateEngineSchema,
} from "./openclaw-state-db-engine.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  cleanupPostgresStateFixture,
  installPostgresStateFixture,
} from "./openclaw-state-db.postgres-fixture.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const bootstrapDeferralColumn = /\n {2}"bootstrap_deferred" bigint,/u;
// Shared-state DDL of the last release before #196392, at the same schema version.
const preDeferralSql = expectDefined(stateEngineSchema.postgres, "Shared-state DDL").replace(
  bootstrapDeferralColumn,
  "",
);

// Reduces a fresh store to the catalog and seal that the predecessor release publishes.
async function sealPreDeferralStore(
  client: pg.Client,
  namespace: string,
  pathname: string,
  schemaPrefix: string,
) {
  const declaration = expectDefined(
    preDeferralSql.match(/CREATE TABLE "workspace_setup_state" \([\s\S]*?\n\);/u)?.[0],
    "Predecessor workspace setup declaration",
  );
  const index = expectDefined(
    preDeferralSql.match(/CREATE INDEX "idx_workspace_setup_state_path"[^;]*;/u)?.[0],
    "Predecessor workspace setup index",
  );
  const references = await client.query<{ source: string; definition: string }>(
    `SELECT conrelid::regclass::text AS source, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE contype = 'f'
       AND confrelid = format('%I.workspace_setup_state', $1::text)::regclass`,
    [namespace],
  );
  // DROP COLUMN leaves an attnum hole; recreate the empty table as the predecessor declared it.
  await client.query(`BEGIN; SET LOCAL search_path TO "${namespace}";
    DROP TABLE workspace_setup_state CASCADE;
    ${declaration}
    ${index}
    ${references.rows.map((ref) => `ALTER TABLE ${ref.source} ADD ${ref.definition};`).join("\n")}
    DROP TABLE device_pairing_browser_requests;
    INSERT INTO workspace_setup_state
      (workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at, updated_at)
      VALUES ('retained', '/fixture/workspace', 1, '2026-11-09T00:00:00.000Z',
        '2026-11-09T00:01:00.000Z', 7);
    UPDATE openclaw_schema_meta SET fingerprint = NULL, ddl_hash = NULL, server_major = NULL;
    COMMIT;`);
  const anchor = openNodeSqliteDatabase(pathname);
  try {
    withEngineStoreAdmission(() =>
      openPostgresEngineTestStore({
        anchor,
        schema: { ...stateEngineSchema, postgres: preDeferralSql, postgresAdditiveColumns: [] },
        existingOnly: true,
        input: { connection: connection!, schemaPrefix },
      }).close(),
    );
  } finally {
    anchor.close();
    retireSqliteDatabaseAdmissionForPath(pathname);
  }
}

async function withPreDeferralStore(
  run: (fixture: {
    client: pg.Client;
    namespace: string;
    options: { path: string; env: NodeJS.ProcessEnv };
    pathname: string;
    readColumn: () => Promise<unknown[]>;
  }) => Promise<void>,
) {
  const directory = tempDirs.make("state-bootstrap-deferral-");
  const pathname = path.join(directory, "state", "openclaw.sqlite");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
  };
  fs.writeFileSync(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({ database: { engine: "postgres", postgres: { connection } } }),
  );
  const options = { path: pathname, env };
  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  installPostgresStateFixture(connection!, "state_bootstrap_deferral");
  let namespace: string | undefined;
  try {
    namespace = withEngineStoreAdmission(() =>
      runOpenClawStateWriteTransaction(
        ({ db }) => expectDefined(getPostgresPhysicalFacts(db), "PostgreSQL facts").namespace,
        options,
      ),
    );
    closeOpenClawStateDatabaseForTest();
    retireSqliteDatabaseAdmissionForPath(pathname);
    await sealPreDeferralStore(client, namespace, pathname, "state_bootstrap_deferral");
    const store = namespace;
    await run({
      client,
      namespace,
      options,
      pathname,
      readColumn: async () =>
        (
          await client.query(
            `SELECT data_type, is_nullable, column_default FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = 'workspace_setup_state'
               AND column_name = 'bootstrap_deferred'`,
            [store],
          )
        ).rows,
    });
  } finally {
    closeOpenClawStateDatabaseForTest();
    await cleanupPostgresStateFixture(client, pathname, namespace);
  }
}

describe.skipIf(!connection)("PostgreSQL shared state sealed before bootstrap deferral", () => {
  it("admits a schema-39 store sealed before bootstrap deferral and keeps its setup rows", async () => {
    await withPreDeferralStore(async ({ client, namespace, options, pathname, readColumn }) => {
      const readSetupRows = () =>
        withEngineStoreAdmission(() =>
          runOpenClawStateWriteTransaction(
            ({ db }) =>
              db
                .prepare(
                  `SELECT workspace_key, workspace_path, bootstrap_seeded_at, setup_completed_at,
                    bootstrap_deferred FROM workspace_setup_state`,
                )
                .all(),
            options,
          ),
        );
      const seal = async () =>
        (await client.query(`SELECT ddl_hash FROM "${namespace}".openclaw_schema_meta`)).rows;
      const predecessorSeal = await seal();
      const inspected = withEngineStoreAdmission(() =>
        openExistingStatePostgresConnection(pathname),
      );
      expect(inspected?.close()).toBe(true);
      retireSqliteDatabaseAdmissionForPath(pathname);
      expect(await readColumn()).toEqual([]);
      expect(await seal()).toEqual(predecessorSeal);

      expect(readSetupRows()).toEqual([
        {
          workspace_key: "retained",
          workspace_path: "/fixture/workspace",
          bootstrap_seeded_at: "2026-11-09T00:00:00.000Z",
          setup_completed_at: "2026-11-09T00:01:00.000Z",
          bootstrap_deferred: null,
        },
      ]);
      expect(await readColumn()).toEqual([
        { data_type: "bigint", is_nullable: "YES", column_default: null },
      ]);
      expect(await seal()).not.toEqual(predecessorSeal);
      closeOpenClawStateDatabaseForTest();
      retireSqliteDatabaseAdmissionForPath(pathname);
      expect(readSetupRows()).toHaveLength(1);
    });
  });

  it("completes a predecessor for a writer while its inspection admission is retained", async () => {
    await withPreDeferralStore(async ({ options, pathname, readColumn }) => {
      const inspected = withEngineStoreAdmission(() =>
        openExistingStatePostgresConnection(pathname),
      );
      try {
        expect(await readColumn()).toEqual([]);
        expect(
          withEngineStoreAdmission(() =>
            runOpenClawStateWriteTransaction(
              ({ db }) =>
                db
                  .prepare(`SELECT workspace_key, bootstrap_deferred FROM workspace_setup_state`)
                  .all(),
              options,
            ),
          ),
        ).toEqual([{ workspace_key: "retained", bootstrap_deferred: null }]);
        expect(await readColumn()).toEqual([
          { data_type: "bigint", is_nullable: "YES", column_default: null },
        ]);
      } finally {
        expect(inspected?.close()).toBe(true);
      }
    });
  });

  it.each([
    {
      shape: "a column added outside OpenClaw under the predecessor seal",
      sql: "ALTER TABLE workspace_setup_state ADD COLUMN bootstrap_deferred bigint",
      error: /schema drift detected\. /u,
    },
    {
      shape: "an integer column on an unsealed store",
      sql: `ALTER TABLE workspace_setup_state ADD COLUMN bootstrap_deferred integer;
        UPDATE openclaw_schema_meta SET fingerprint = NULL, ddl_hash = NULL, server_major = NULL`,
      error: /schema drift detected against generated DDL/u,
    },
    {
      shape: "an unrelated column on an unsealed predecessor",
      sql: `ALTER TABLE workspace_setup_state ADD COLUMN unrelated text;
        UPDATE openclaw_schema_meta SET fingerprint = NULL, ddl_hash = NULL, server_major = NULL`,
      error: /schema drift detected against generated DDL/u,
    },
  ])("refuses $shape without changing it", async ({ sql, error }) => {
    await withPreDeferralStore(async ({ client, namespace, options, readColumn }) => {
      await client.query(`BEGIN; SET LOCAL search_path TO "${namespace}"; ${sql}; COMMIT;`);
      const before = await readColumn();
      expect(() =>
        withEngineStoreAdmission(() => runOpenClawStateWriteTransaction(() => undefined, options)),
      ).toThrow(error);
      expect(await readColumn()).toEqual(before);
    });
  });
});
