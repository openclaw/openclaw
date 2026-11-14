import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { loadStatePortDescriptor } from "../../infra/database-engine/state-port-descriptor.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { stateEngineSchema } from "../../state/openclaw-state-db-engine.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { inspectStateDatabaseSchema } from "../../state/openclaw-state-schema-preflight.js";
import { getOpenClawStatePredecessorSchema } from "../../state/openclaw-state-schema-runtime.js";
import { withStateMigrationBackupForTest } from "../../state/openclaw-state-schema.test-support.js";
import { assertSqliteMigrationScopePreserved } from "../../state/sqlite-migration-scope.test-support.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createWorkerEnvironmentStore } from "./store.js";

const directories = useStateDatabaseTempDirs();
const receipt = { version: 1, leaseId: "lease-uncertain", identity: { diskId: "disk-original" } };
function legacyDatabase(refusePublication = false) {
  const options = { env: { OPENCLAW_STATE_DIR: directories.make("worker-source-v39-") } };
  const pathname = resolveOpenClawStateSqlitePath(options.env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(getOpenClawStatePredecessorSchema(39));
  db.exec(`PRAGMA user_version = 39;
    INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
    VALUES ('primary', 'global', 39, 1, 1);`);
  for (const state of [
    "requested",
    "provisioning",
    "bootstrapping",
    "ready",
    "idle",
    "attached",
    "failed",
  ] as const) {
    const leased = ["bootstrapping", "ready", "idle", "attached"].includes(state);
    db.prepare(`INSERT INTO worker_environments (environment_id, provider_id, profile_id,
      profile_snapshot_json, provision_operation_id, state, lease_id, node_device_id,
      resource_receipt_json, attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms)
      VALUES (?, 'provider', 'profile', '{"settings":{}}', ?, ?, ?, ?, ?, ?, 1000, 1000, 1000)`).run(
      state,
      `provision-${state}`,
      state,
      leased ? `lease-${state}` : null,
      leased && state !== "bootstrapping" ? `node-${state}` : null,
      state === "provisioning" ? JSON.stringify(receipt) : null,
      state === "attached" ? '["retained-session"]' : "[]",
    );
  }
  db.exec(`UPDATE worker_environments SET ssh_host='worker.example.test', ssh_port=2222,
    ssh_user='openclaw', ssh_host_key='ssh-ed25519 AAAA',
    ssh_key_ref_json='{"source":"env","provider":"default","id":"WORKER_SSH_KEY"}'
    WHERE state='bootstrapping'`);
  db.exec(`INSERT INTO worker_environments (environment_id, provider_id, profile_id,
    profile_snapshot_json, provision_operation_id, state, lease_id, owner_epoch,
    ssh_host, ssh_port, ssh_user, ssh_host_key, ssh_key_ref_json,
    created_at_ms, updated_at_ms, state_changed_at_ms)
    SELECT 'maintenance', provider_id, profile_id, profile_snapshot_json,
      'maintenance', state, 'lease-maintenance', 1, ssh_host, ssh_port, ssh_user,
      ssh_host_key, ssh_key_ref_json, created_at_ms, updated_at_ms, state_changed_at_ms
    FROM worker_environments WHERE environment_id='bootstrapping'`);
  db.exec(
    "INSERT INTO diagnostic_events VALUES ('synthetic', 'retained', '{\"keep\":true}', 100, 1)",
  );
  if (refusePublication) {
    db.exec(`CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  }
  return {
    options,
    pathname,
    before: db.prepare("SELECT * FROM worker_environments ORDER BY environment_id").all(),
  };
}

it.each(["runtime", "doctor"] as const)(
  "migrates v39 through %s without inventing original provisioning authority",
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
      expect(
        database.db.prepare("SELECT * FROM worker_environments ORDER BY environment_id").all(),
      ).toEqual(
        before.map((row) =>
          Object.assign({}, row, {
            provision_source_json:
              ["requested", "provisioning"].includes(String(row.state)) ||
              (row.state === "bootstrapping" && row.owner_epoch === 0)
                ? '{"kind":"unavailable"}'
                : null,
          }),
        ),
      );
      expect(
        runSqliteReadOperationSync(scope, () =>
          inspectStateDatabaseSchema(scope, {
            pathname,
            supportedVersion: 39,
            scope: "state",
            purpose: "runtime",
          }),
        ).schemas.incompatible,
      ).toMatchObject([{ foundVersion: OPENCLAW_STATE_SCHEMA_VERSION, supportedVersion: 39 }]);
      const store = await createWorkerEnvironmentStore({ database });
      expect(store.get("requested")?.provisionSource).toEqual({ kind: "unavailable" });
      expect(store.get("provisioning")).toMatchObject({
        state: "provisioning",
        provisionSource: { kind: "unavailable" },
        resourceReceipt: receipt,
      });
      expect(store.get("bootstrapping")).toMatchObject({
        state: "bootstrapping",
        leaseId: "lease-bootstrapping",
        provisionSource: { kind: "unavailable" },
      });
      for (const state of ["ready", "idle", "attached", "failed", "maintenance"]) {
        expect(store.get(state)?.provisionSource).toBeUndefined();
      }
      await closeOpenClawStateDatabaseAsync();
      const reopened = await createWorkerEnvironmentStore({
        database: openOpenClawStateDatabase(options),
      });
      expect(reopened.get("provisioning")).toMatchObject({
        provisionOperationId: "provision-provisioning",
        provisionSource: { kind: "unavailable" },
        resourceReceipt: receipt,
      });
    });
  },
);

it("rolls back source DDL, legacy refusal, and schema publication together", async () => {
  const { options, pathname, before } = legacyDatabase(true);
  await expect(
    withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
  ).rejects.toThrow("fixture publication refusal");
  await closeOpenClawStateDatabaseAsync();
  using db = new DatabaseSync(pathname, { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 39 });
  expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
    schema_version: 39,
  });
  expect(db.prepare("SELECT * FROM worker_environments ORDER BY environment_id").all()).toEqual(
    before,
  );
});

it("keeps PostgreSQL v39 backups free of source metadata and migrates pending authority", async () => {
  const before = await loadStatePortDescriptor(39);
  const after = await loadStatePortDescriptor(40);
  const columns = (descriptor: typeof before) =>
    descriptor.tables.find((table) => table.name === "worker_environments")?.columns;
  expect(columns(before)?.map((column) => column.name)).not.toContain("provision_source_json");
  expect(columns(after)).toContainEqual({ name: "provision_source_json", type: "text" });
  const migration = stateEngineSchema.postgresMigrations?.find(({ version }) => version === 40);
  expect(migration?.fromSchema.postgres).not.toContain('"provision_source_json"');
  expect(migration?.schema.postgres).toContain('"provision_source_json" text COLLATE "C",');
});
