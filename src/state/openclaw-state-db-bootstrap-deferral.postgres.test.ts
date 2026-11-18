import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { openPostgresEngineTestStore } from "../infra/database-engine/engine-store.test-support.js";
import { inspectDatabasePort } from "../infra/database-engine/port.worker.js";
import { loadStatePortDescriptor } from "../infra/database-engine/state-port-descriptor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { PostgresSyncConnection } from "../infra/postgres-sync/connection.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import { openExistingStatePostgresConnection } from "./openclaw-state-db-engine.js";
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
const schemaPrefix = "state_bootstrap_deferral";

// v2026.11.5's generated runtime eager DDL followed by its version-additive fragments,
// in their original order. Keep this fixture independent of the candidate's schema.
const releasedDdl = fs.readFileSync(
  new URL("./fixtures/state-postgres-v2026.11.5.sql", import.meta.url),
  "utf8",
);

// The eager DDL delta at caa978caae7 and its version-additive browser-pairing fragment.
const v39Ddl = releasedDdl
  .replace(
    '  "shared_host" bigint,\n',
    '  "shared_host" bigint,\n  "resource_receipt_json" text COLLATE "C",\n  "retention_json" text COLLATE "C",\n',
  )
  .replace(
    '  "repository_workspace_id" text COLLATE "C",\n  "created_at_ms" bigint NOT NULL,\n',
    '  "repository_workspace_id" text COLLATE "C",\n  "created_at_ms" bigint NOT NULL,\n  "repository_disk_authority_json" text COLLATE "C",\n',
  )
  .replace(
    '  "attestation_updated_at_ms" bigint,\n',
    '  "attestation_updated_at_ms" bigint,\n  "bootstrap_deferred" bigint,\n',
  )
  .replace(
    'CREATE TABLE "skill_workshop_changes"',
    `CREATE TABLE "device_pairing_browser_requests" (
  "request_id" text COLLATE "C" NOT NULL,
  "code" text COLLATE "C" NOT NULL,
  "device_id" text COLLATE "C" NOT NULL,
  "public_key" text COLLATE "C" NOT NULL,
  "remote_ip" text COLLATE "C",
  "user_agent" text COLLATE "C",
  "origin" text COLLATE "C",
  "status" text COLLATE "C" NOT NULL,
  "approved_token_sha256" text COLLATE "C",
  "created_at_ms" bigint NOT NULL,
  "expires_at_ms" bigint NOT NULL,
  PRIMARY KEY ("request_id"),
  CHECK (("status" IN ('pending', 'approved', 'rejected'))),
  UNIQUE ("code"),
  UNIQUE ("device_id")
);

-- Generated runtime DDL; the owner supplies search_path and the transaction.

CREATE TABLE "skill_workshop_changes"`,
  );

describe.skipIf(!connection)("PostgreSQL shared state bootstrap deferral upgrade", () => {
  it.each([
    { version: 36, column: false, retain: true, drift: false },
    { version: 39, column: false, retain: false, drift: false },
    { version: 39, column: true, retain: true, drift: false },
    { version: 36, column: false, retain: false, drift: true },
  ])(
    "opens schema $version with column=$column and drift=$drift",
    async ({ version, column, retain, drift }) => {
      const directory = tempDirs.make("state-bootstrap-deferral-");
      const pathname = path.join(directory, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(pathname));
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: directory,
        OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
      };
      fs.writeFileSync(
        env.OPENCLAW_CONFIG_PATH,
        JSON.stringify({ database: { engine: "postgres", postgres: { connection } } }),
      );
      const client = new pg.Client({ connectionString: connection });
      await client.connect();
      installPostgresStateFixture(connection!, schemaPrefix);
      let namespace: string | undefined;
      let storeId: string | undefined;
      try {
        withEngineStoreAdmission(() => {
          using anchor = openNodeSqliteDatabase(pathname);
          const db = openPostgresEngineTestStore({
            anchor,
            schema: {
              id: "state",
              version,
              sqlite: "",
              postgres:
                version === 36
                  ? releasedDdl
                  : column
                    ? v39Ddl
                    : v39Ddl.replace('  "bootstrap_deferred" bigint,\n', ""),
            },
            input: { connection: connection!, schemaPrefix },
          });
          try {
            if (!(db instanceof PostgresSyncConnection)) {
              throw new Error("Expected a PostgreSQL fixture");
            }
            namespace = db.schema;
            storeId = db.storeId;
          } finally {
            db.close();
          }
        });
        retireSqliteDatabaseAdmissionForPath(pathname);
        const store = `"${namespace}"`;
        await client.query(`
        INSERT INTO ${store}.schema_meta
          (meta_key, role, schema_version, app_version, created_at, updated_at)
          VALUES ('primary', 'global', ${version}, '2026.11.5', 1, 1);
        INSERT INTO ${store}.config_machine_state (state_key, value_json, updated_at_ms)
          VALUES ('state.schema.contentVersion', '${version}', 1);
        INSERT INTO ${store}.workspace_setup_state (workspace_key, workspace_path, version, updated_at)
          VALUES ('retained', '/fixture/workspace', 1, 7);
        ${column ? `UPDATE ${store}.workspace_setup_state SET bootstrap_deferred = 1;` : ""}
        ${
          drift
            ? `UPDATE ${store}.openclaw_schema_meta
          SET ddl_hash = NULL, fingerprint = NULL, server_major = NULL;`
            : ""
        }
        ${drift ? `ALTER TABLE ${store}.workspace_setup_state ADD COLUMN unrelated text;` : ""}
      `);
        const metadata = async () =>
          (
            await client.query(
              `SELECT version::int, ddl_hash, fingerprint FROM ${store}.openclaw_schema_meta`,
            )
          ).rows[0];
        const openWriter = () =>
          withEngineStoreAdmission(() =>
            runOpenClawStateWriteTransaction(
              ({ db }) =>
                db
                  .prepare(
                    "SELECT workspace_key, workspace_path, updated_at, bootstrap_deferred FROM workspace_setup_state",
                  )
                  .all(),
              { path: pathname, env },
            ),
          );
        const before = await metadata();
        if (drift) {
          expect(openWriter).toThrow(/schema drift detected against generated DDL/u);
          expect(await metadata()).toEqual(before);
          return;
        }
        const inspection = withEngineStoreAdmission(() =>
          openExistingStatePostgresConnection(pathname),
        );
        try {
          expect(
            withEngineStoreAdmission(() =>
              inspection?.database.db
                .prepare("SELECT workspace_key FROM workspace_setup_state")
                .get(),
            ),
          ).toEqual({ workspace_key: "retained" });
          expect(await metadata()).toEqual(before);
          const backup = await inspectDatabasePort(
            { engine: "postgres", db: client, namespace: namespace! },
            await loadStatePortDescriptor(version),
            storeId,
            true,
          );
          expect(backup.tables).toHaveProperty("workspace_setup_state");
          if (!retain) {
            expect(inspection?.close()).toBe(true);
            retireSqliteDatabaseAdmissionForPath(pathname);
          }
          expect(openWriter()).toEqual([
            {
              workspace_key: "retained",
              workspace_path: "/fixture/workspace",
              updated_at: 7,
              bootstrap_deferred: column ? 1 : null,
            },
          ]);
        } finally {
          if (inspection?.database.db.isOpen) {
            expect(inspection.close()).toBe(true);
          }
        }
        const sealed = await metadata();
        expect(sealed).toEqual({
          version: OPENCLAW_STATE_SCHEMA_VERSION,
          ddl_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });
        closeOpenClawStateDatabaseForTest();
        retireSqliteDatabaseAdmissionForPath(pathname);
        expect(openWriter()).toHaveLength(1);
        expect(await metadata()).toEqual(sealed);
      } finally {
        closeOpenClawStateDatabaseForTest();
        await cleanupPostgresStateFixture(client, pathname, namespace);
      }
    },
  );
});
