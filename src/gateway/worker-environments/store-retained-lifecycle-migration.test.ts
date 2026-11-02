import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { loadStatePortDescriptor } from "../../infra/database-engine/state-port-descriptor.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { stateEngineSchema } from "../../state/openclaw-state-db-engine.js";
import { stateTemplateNamesMigration } from "../../state/openclaw-state-db-schema-v36-template-names.js";
import { stateWorkerDiskMigrations } from "../../state/openclaw-state-db-schema-v38-repository-disk.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { inspectStateDatabaseSchema } from "../../state/openclaw-state-schema-preflight.js";
import { withStateMigrationBackupForTest } from "../../state/openclaw-state-schema.test-support.js";
import { assertSqliteMigrationScopePreserved } from "../../state/sqlite-migration-scope.test-support.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createWorkerEnvironmentStore } from "./store.js";

const directories = useStateDatabaseTempDirs();
const predecessor = readFileSync(
  new URL("../../../test/fixtures/sqlite/openclaw-state-schema-v35.sql", import.meta.url),
  "utf8",
);
const receipt = { version: 1, leaseId: "lease-original", identity: { diskId: "disk-original" } };
function legacyDatabase(refusePublication = false) {
  const env = { OPENCLAW_STATE_DIR: directories.make("worker-retention-v38-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(predecessor);
  stateTemplateNamesMigration.migrate(db, 35);
  for (const step of stateWorkerDiskMigrations) {
    step.migrate(db, 36);
  }
  db.exec(
    "PRAGMA user_version = 38; INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at) VALUES ('primary', 'global', 38, 1, 1);",
  );
  db.prepare(
    "INSERT INTO worker_environments (environment_id, provider_id, profile_id, profile_snapshot_json, provision_operation_id, state, lease_id, resource_receipt_json, created_at_ms, updated_at_ms, state_changed_at_ms) VALUES ('environment', 'provider', 'profile', '{\"settings\":{}}', 'provision-original', 'idle', 'lease-original', ?, 1000, 1000, 1000)",
  ).run(JSON.stringify(receipt));
  db.exec(
    "INSERT INTO session_repository_workspaces (workspace_id, agent_id, session_key, url, branch, revision, created_at_ms, updated_at_ms, disk_authority_json) VALUES ('11111111-1111-4111-8111-111111111111', 'agent', 'session', 'https://example.test/repo.git', 'main', 7, 1, 2, '{\"mode\":\"retained-original\"}');",
  );
  db.exec(
    "INSERT INTO diagnostic_events VALUES ('synthetic', 'retained', '{\"keep\":true}', 100, 1);",
  );
  if (refusePublication) {
    db.exec(
      "CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;",
    );
  }
  return {
    options: { env, path: pathname },
    pathname,
    before: db.prepare("SELECT * FROM worker_environments").get(),
  };
}

it.each(["runtime", "doctor"] as const)(
  "migrates v38 through %s without changing existing disk custody or inventing retention",
  async (owner) => {
    const { options, pathname, before } = legacyDatabase();
    await withStateMigrationBackupForTest(options, async () => {
      using scope = new DatabaseSync(pathname);
      await assertSqliteMigrationScopePreserved(
        scope,
        ["worker_environments", "schema_meta", "config_machine_state"],
        () => {
          if (owner === "doctor") {
            expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
          }
          openOpenClawStateDatabase(options);
        },
      );
      const database = openOpenClawStateDatabase(options);
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(database.db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(database.db.prepare("SELECT * FROM worker_environments").get()).toEqual({
        ...before,
        retention_json: null,
      });
      expect(
        runSqliteReadOperationSync(scope, () =>
          inspectStateDatabaseSchema(scope, {
            pathname,
            supportedVersion: 38,
            scope: "state",
            purpose: "runtime",
          }),
        ).schemas.incompatible,
      ).toMatchObject([{ foundVersion: 39, supportedVersion: 38 }]);
      const store = await createWorkerEnvironmentStore({ database });
      expect(store.get("environment")).toMatchObject({ resourceReceipt: receipt, retention: null });
      await closeOpenClawStateDatabaseAsync();
      const reopened = await createWorkerEnvironmentStore({
        database: openOpenClawStateDatabase(options),
      });
      expect(reopened.get("environment")).toMatchObject({
        resourceReceipt: receipt,
        retention: null,
      });
    });
  },
);

it("rolls back retention DDL and version publication together", async () => {
  const { options, pathname, before } = legacyDatabase(true);
  await expect(
    withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
  ).rejects.toThrow("fixture publication refusal");
  await closeOpenClawStateDatabaseAsync();
  using db = new DatabaseSync(pathname, { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 38 });
  expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
    schema_version: 38,
  });
  expect(db.prepare("SELECT * FROM worker_environments").get()).toEqual(before);
});

it("keeps PostgreSQL v38 backups independent of the nullable v39 retention column", async () => {
  const before = await loadStatePortDescriptor(38);
  const after = await loadStatePortDescriptor(39);
  const columns = (descriptor: typeof before) =>
    descriptor.tables.find((table) => table.name === "worker_environments")?.columns;
  expect(columns(before)?.map((column) => column.name)).not.toContain("retention_json");
  expect(columns(after)).toContainEqual({ name: "retention_json", type: "text" });
  const migration = stateEngineSchema.postgresMigrations?.find(({ version }) => version === 39);
  expect(migration?.fromSchema.postgres).not.toContain('"retention_json"');
  expect(migration?.fromSchema.postgres).toContain('"resource_receipt_json"');
  expect(migration?.schema.postgres).toContain('"retention_json" text COLLATE "C",');
  expect(migration?.sql).toContain(
    'ALTER TABLE worker_environments ADD COLUMN retention_json text COLLATE "C";',
  );
});
