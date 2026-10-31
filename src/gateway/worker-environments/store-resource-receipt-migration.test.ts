import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { loadStatePortDescriptor } from "../../infra/database-engine/state-port-descriptor.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { stateEngineSchema } from "../../state/openclaw-state-db-engine.js";
import { stateTemplateNamesMigration } from "../../state/openclaw-state-db-schema-v36-template-names.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withStateMigrationBackupForTest } from "../../state/openclaw-state-schema.test-support.js";
import { assertSqliteMigrationScopePreserved } from "../../state/sqlite-migration-scope.test-support.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createWorkerEnvironmentStore } from "./store.js";

const directories = useStateDatabaseTempDirs();
const predecessor = readFileSync(
  new URL("../../../test/fixtures/sqlite/openclaw-state-schema-v35.sql", import.meta.url),
  "utf8",
);
const receipt = {
  version: 1 as const,
  leaseId: "lease-original",
  identity: { diskId: "disk-original" },
};
function legacyDatabase(refusePublication = false) {
  const env = { OPENCLAW_STATE_DIR: directories.make("resource-receipt-v36-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(predecessor);
  stateTemplateNamesMigration.migrate(db, 35);
  db.exec(
    "PRAGMA user_version = 36; INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at) VALUES ('primary', 'global', 36, 1, 1);",
  );
  db.exec(
    "INSERT INTO worker_environments (environment_id, provider_id, profile_id, profile_snapshot_json, provision_operation_id, state, created_at_ms, updated_at_ms, state_changed_at_ms) VALUES ('environment', 'provider', 'profile', '{\"settings\":{}}', 'provision-original', 'provisioning', 1000, 1000, 1000);",
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
  "migrates v36 through %s without inventing resource identity, then persists through the worker",
  async (owner) => {
    const { options, pathname, before } = legacyDatabase();
    await withStateMigrationBackupForTest(options, async () => {
      using scope = new DatabaseSync(pathname);
      await assertSqliteMigrationScopePreserved(
        scope,
        [
          "worker_environments",
          "session_repository_workspaces",
          "worker_workspace_pending_results",
          "schema_meta",
          "config_machine_state",
        ],
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
      expect(database.db.prepare("SELECT * FROM worker_environments").get()).toEqual({
        ...before,
        resource_receipt_json: null,
      });
      const store = await createWorkerEnvironmentStore({ database });
      expect(store.get("environment")?.resourceReceipt).toBeNull();
      await store.recordResourceReceipt({
        environmentId: "environment",
        provisionOperationId: "provision-original",
        receipt,
        assertCurrent: () => {},
      });
      await closeOpenClawStateDatabaseAsync();
      const reopened = await createWorkerEnvironmentStore({
        database: openOpenClawStateDatabase(options),
      });
      expect(reopened.get("environment")?.resourceReceipt).toEqual(receipt);
    });
  },
);

it("rolls back receipt DDL and schema markers if migration publication fails", async () => {
  const { options, pathname, before } = legacyDatabase(true);
  await expect(
    withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
  ).rejects.toThrow("fixture publication refusal");
  await closeOpenClawStateDatabaseAsync();
  using db = new DatabaseSync(pathname, { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 36 });
  expect(db.prepare("SELECT * FROM worker_environments").get()).toEqual(before);
  expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
    schema_version: 36,
  });
});

it("keeps PostgreSQL predecessor backups and nullable receipt column migration aligned", async () => {
  const predecessorDescriptor = await loadStatePortDescriptor(36);
  const current = await loadStatePortDescriptor(37);
  expect(
    predecessorDescriptor.tables
      .find((table) => table.name === "worker_environments")
      ?.columns.map((column) => column.name),
  ).not.toContain("resource_receipt_json");
  expect(
    current.tables.find((table) => table.name === "worker_environments")?.columns,
  ).toContainEqual({ name: "resource_receipt_json", type: "text" });
  const migration = stateEngineSchema.postgresMigrations?.find(({ version }) => version === 37);
  expect(migration).toBeDefined();
  expect(migration?.fromSchema.postgres).not.toContain('"resource_receipt_json"');
  expect(migration?.schema.postgres).toContain('"resource_receipt_json" text COLLATE "C",');
  expect(migration?.sql).toContain(
    'ALTER TABLE worker_environments ADD COLUMN resource_receipt_json text COLLATE "C";',
  );
});
