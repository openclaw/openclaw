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
import { getOpenClawStatePredecessorSchema } from "../../state/openclaw-state-schema-runtime.js";
import { withStateMigrationBackupForTest } from "../../state/openclaw-state-schema.test-support.js";
import { assertSqliteMigrationScopePreserved } from "../../state/sqlite-migration-scope.test-support.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createWorkerEnvironmentStore } from "./store.js";

const columns = { 36: "resource_receipt_json", 38: "retention_json", 39: "provision_source_json" };
const rowsSql = "SELECT * FROM worker_environments ORDER BY environment_id";

export function registerWorkerStoreMigrationTests(version: 36 | 38 | 39) {
  const directories = useStateDatabaseTempDirs();
  const receipt = {
    version: 1 as const,
    leaseId: version === 39 ? "lease-uncertain" : "lease-original",
    identity: { diskId: "disk-original" },
  };
  function legacyDatabase(refusePublication = false) {
    const env = { OPENCLAW_STATE_DIR: directories.make("worker-migration-v" + version + "-") };
    const pathname = resolveOpenClawStateSqlitePath(env);
    mkdirSync(path.dirname(pathname), { recursive: true });
    using db = new DatabaseSync(pathname);
    if (version === 39) {
      db.exec(getOpenClawStatePredecessorSchema(39));
    } else {
      db.exec(
        readFileSync(
          new URL("../../../test/fixtures/sqlite/openclaw-state-schema-v35.sql", import.meta.url),
          "utf8",
        ),
      );
      stateTemplateNamesMigration.migrate(db, 35);
      if (version === 38) {
        for (const step of stateWorkerDiskMigrations) {
          step.migrate(db, 36);
        }
      }
    }
    db.exec("PRAGMA user_version = " + version);
    db.prepare(
      "INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at) VALUES ('primary', 'global', ?, 1, 1)",
    ).run(version);
    if (version === 39) {
      // Pending initial boots lack provenance; maintenance boots already have an owner epoch.
      for (const state of [
        "requested",
        "provisioning",
        "bootstrapping",
        "ready",
        "idle",
        "attached",
        "failed",
      ]) {
        const leased = ["bootstrapping", "ready", "idle", "attached"].includes(state);
        db.prepare(
          "INSERT INTO worker_environments (environment_id, provider_id, profile_id, profile_snapshot_json, provision_operation_id, state, lease_id, node_device_id, resource_receipt_json, attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms) VALUES (?, 'provider', 'profile', '{\"settings\":{}}', ?, ?, ?, ?, ?, ?, 1000, 1000, 1000)",
        ).run(
          state,
          "provision-" + state,
          state,
          leased ? "lease-" + state : null,
          leased && state !== "bootstrapping" ? "node-" + state : null,
          state === "provisioning" ? JSON.stringify(receipt) : null,
          state === "attached" ? '["retained-session"]' : "[]",
        );
      }
      db.exec(
        'UPDATE worker_environments SET ssh_host=\'worker.example.test\', ssh_port=2222, ssh_user=\'openclaw\', ssh_host_key=\'ssh-ed25519 AAAA\', ssh_key_ref_json=\'{"source":"env","provider":"default","id":"WORKER_SSH_KEY"}\' WHERE state=\'bootstrapping\'',
      );
      db.exec(
        "INSERT INTO worker_environments (environment_id, provider_id, profile_id, profile_snapshot_json, provision_operation_id, state, lease_id, owner_epoch, ssh_host, ssh_port, ssh_user, ssh_host_key, ssh_key_ref_json, created_at_ms, updated_at_ms, state_changed_at_ms) SELECT 'maintenance', provider_id, profile_id, profile_snapshot_json, 'maintenance', state, 'lease-maintenance', 1, ssh_host, ssh_port, ssh_user, ssh_host_key, ssh_key_ref_json, created_at_ms, updated_at_ms, state_changed_at_ms FROM worker_environments WHERE environment_id='bootstrapping'",
      );
    } else if (version === 38) {
      db.prepare(
        "INSERT INTO worker_environments (environment_id, provider_id, profile_id, profile_snapshot_json, provision_operation_id, state, lease_id, resource_receipt_json, created_at_ms, updated_at_ms, state_changed_at_ms) VALUES ('environment', 'provider', 'profile', '{\"settings\":{}}', 'provision-original', 'idle', 'lease-original', ?, 1000, 1000, 1000)",
      ).run(JSON.stringify(receipt));
      db.exec(
        "INSERT INTO session_repository_workspaces (workspace_id, agent_id, session_key, url, branch, revision, created_at_ms, updated_at_ms, disk_authority_json) VALUES ('11111111-1111-4111-8111-111111111111', 'agent', 'session', 'https://example.test/repo.git', 'main', 7, 1, 2, '{\"mode\":\"retained-original\"}')",
      );
    } else {
      db.exec(
        "INSERT INTO worker_environments (environment_id, provider_id, profile_id, profile_snapshot_json, provision_operation_id, state, created_at_ms, updated_at_ms, state_changed_at_ms) VALUES ('environment', 'provider', 'profile', '{\"settings\":{}}', 'provision-original', 'provisioning', 1000, 1000, 1000)",
      );
    }
    db.exec(
      "INSERT INTO diagnostic_events VALUES ('synthetic', 'retained', '{\"keep\":true}', 100, 1)",
    );
    if (refusePublication) {
      db.exec(
        "CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;",
      );
    }
    return { options: { env, path: pathname }, pathname, before: db.prepare(rowsSql).all() };
  }

  it.each(["runtime", "doctor"] as const)(
    "migrates v" + version + " through %s without inventing custody or provisioning authority",
    async (owner) => {
      const { options, pathname, before } = legacyDatabase();
      await withStateMigrationBackupForTest(options, async () => {
        using scope = new DatabaseSync(pathname);
        await assertSqliteMigrationScopePreserved(
          scope,
          [
            "worker_environments",
            "schema_meta",
            "config_machine_state",
            ...(version === 36
              ? ["session_repository_workspaces", "worker_workspace_pending_results"]
              : []),
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
        expect(database.db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
          schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
        });
        expect(database.db.prepare(rowsSql).all()).toEqual(
          before.map((row) =>
            Object.assign({}, row, {
              ...(version === 36 ? { resource_receipt_json: null } : {}),
              ...(version !== 39 ? { retention_json: null } : {}),
              provision_source_json:
                ["requested", "provisioning"].includes(String(row.state)) ||
                (row.state === "bootstrapping" && row.owner_epoch === 0)
                  ? '{"kind":"unavailable"}'
                  : null,
            }),
          ),
        );
        if (version !== 36) {
          expect(
            runSqliteReadOperationSync(scope, () =>
              inspectStateDatabaseSchema(scope, {
                pathname,
                supportedVersion: version,
                scope: "state",
                purpose: "runtime",
              }),
            ).schemas.incompatible,
          ).toMatchObject([
            { foundVersion: OPENCLAW_STATE_SCHEMA_VERSION, supportedVersion: version },
          ]);
        }
        const store = await createWorkerEnvironmentStore({ database });
        if (version === 36) {
          expect(store.get("environment")?.resourceReceipt).toBeNull();
          await store.recordResourceReceipt({
            environmentId: "environment",
            provisionOperationId: "provision-original",
            receipt,
            assertCurrent: () => {},
          });
        } else if (version === 38) {
          expect(store.get("environment")).toMatchObject({
            resourceReceipt: receipt,
            retention: null,
          });
        } else {
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
        }
        await closeOpenClawStateDatabaseAsync();
        const reopened = await createWorkerEnvironmentStore({
          database: openOpenClawStateDatabase(options),
        });
        if (version === 39) {
          expect(reopened.get("provisioning")).toMatchObject({
            provisionOperationId: "provision-provisioning",
            provisionSource: { kind: "unavailable" },
            resourceReceipt: receipt,
          });
        } else if (version === 38) {
          expect(reopened.get("environment")).toMatchObject({
            resourceReceipt: receipt,
            retention: null,
          });
        } else {
          expect(reopened.get("environment")?.resourceReceipt).toEqual(receipt);
        }
      });
    },
  );

  it("rolls back v" + version + " DDL, rows, and schema publication together", async () => {
    const { options, pathname, before } = legacyDatabase(true);
    await expect(
      withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
    ).rejects.toThrow("fixture publication refusal");
    await closeOpenClawStateDatabaseAsync();
    using db = new DatabaseSync(pathname, { readOnly: true });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
    expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
      schema_version: version,
    });
    expect(db.prepare(rowsSql).all()).toEqual(before);
  });

  it(
    "keeps PostgreSQL v" + version + " backups and the next column migration aligned",
    async () => {
      const column = columns[version];
      const before = await loadStatePortDescriptor(version);
      const after = await loadStatePortDescriptor(version + 1);
      const tableColumns = (descriptor: typeof before) =>
        descriptor.tables.find((table) => table.name === "worker_environments")?.columns;
      expect(tableColumns(before)?.map((entry) => entry.name)).not.toContain(column);
      expect(tableColumns(after)).toContainEqual({ name: column, type: "text" });
      const migration = stateEngineSchema.postgresMigrations?.find(
        (entry) => entry.version === version + 1,
      );
      expect(migration).toBeDefined();
      expect(migration?.fromSchema.postgres).not.toContain('"' + column + '"');
      expect(migration?.schema.postgres).toContain('"' + column + '" text COLLATE "C",');
      if (version !== 39) {
        expect(migration?.sql).toContain(
          "ALTER TABLE worker_environments ADD COLUMN " + column + ' text COLLATE "C";',
        );
      }
      if (version === 38) {
        expect(migration?.fromSchema.postgres).toContain('"resource_receipt_json"');
      }
    },
  );
}
