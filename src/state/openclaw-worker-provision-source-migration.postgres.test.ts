import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { createPostgresEngineTestFixture } from "../infra/database-engine/engine-store.test-support.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!connection)("PostgreSQL worker provisioning source migration", () => {
  it("refuses lost original sources while preserving running workers and uncertain custody", () => {
    withEngineStoreAdmission(() => {
      const migration = stateEngineSchema.postgresMigrations?.find((step) => step.version === 40);
      if (!migration) {
        throw new Error("Missing state40 migration");
      }
      const source = {
        ...stateEngineSchema,
        ...migration.fromSchema,
        version: 39,
        postgresMigrations: [],
      };
      using fixture = createPostgresEngineTestFixture({
        directory: dirs.make("worker-source-upgrade-"),
        connection: connection!,
        schemaPrefix: "worker_source_upgrade_test",
        schema: source,
      });
      const original = fixture.open();
      original.runTransaction(() => {
        original.exec(`INSERT INTO schema_meta (meta_key,role,schema_version,created_at,updated_at)
          VALUES ('primary','global',39,1,1);
          INSERT INTO worker_environments (environment_id,provider_id,profile_id,profile_snapshot_json,
            provision_operation_id,state,lease_id,node_device_id,resource_receipt_json,
            created_at_ms,updated_at_ms,state_changed_at_ms)
          VALUES ('requested','provider','profile','{"settings":{}}','requested','requested',NULL,NULL,NULL,1,1,1),
            ('provisioning','provider','profile','{"settings":{}}','uncertain','provisioning',NULL,NULL,
              '{"version":1,"leaseId":"lease-uncertain","identity":{"diskId":"disk-original"}}',1,1,1),
            ('ready','provider','profile','{"settings":{}}','ready','ready','lease-ready','node-ready',NULL,1,1,1),
            ('failed','provider','profile','{"settings":{}}','failed','failed',NULL,NULL,NULL,1,1,1);
          INSERT INTO worker_environments (environment_id,provider_id,profile_id,profile_snapshot_json,
            provision_operation_id,state,lease_id,ssh_host,ssh_port,ssh_user,ssh_host_key,ssh_key_ref_json,
            created_at_ms,updated_at_ms,state_changed_at_ms)
          VALUES ('bootstrapping','provider','profile','{"settings":{}}','bootstrap','bootstrapping',
            'lease-bootstrap','worker.example.test',2222,'openclaw','ssh-ed25519 AAAA',
            '{"source":"env","provider":"default","id":"WORKER_SSH_KEY"}',1,1,1);
          INSERT INTO worker_environments (environment_id,provider_id,profile_id,profile_snapshot_json,
            provision_operation_id,state,lease_id,node_device_id,attached_session_ids_json,
            created_at_ms,updated_at_ms,state_changed_at_ms)
          VALUES ('idle','provider','profile','{"settings":{}}','idle','idle','lease-idle','node-idle','[]',1,1,1),
            ('attached','provider','profile','{"settings":{}}','attached','attached',
              'lease-attached','node-attached','["retained-session"]',1,1,1);`);
      });
      original.exec(`INSERT INTO worker_environments (environment_id, provider_id, profile_id,
        profile_snapshot_json, provision_operation_id, state, lease_id, owner_epoch,
        ssh_host, ssh_port, ssh_user, ssh_host_key, ssh_key_ref_json,
        created_at_ms, updated_at_ms, state_changed_at_ms)
        SELECT 'maintenance', provider_id, profile_id, profile_snapshot_json,
          'maintenance', state, 'lease-maintenance', 1, ssh_host, ssh_port, ssh_user,
          ssh_host_key, ssh_key_ref_json, created_at_ms, updated_at_ms, state_changed_at_ms
        FROM worker_environments WHERE environment_id='bootstrapping'`);
      const before = original
        .prepare("SELECT * FROM worker_environments ORDER BY environment_id")
        .all();
      fixture.invalidate();
      const upgraded = fixture.open(stateEngineSchema);
      const expected = before.map((row) =>
        Object.assign({}, row, {
          provision_source_json:
            ["requested", "provisioning"].includes(String(row.state)) ||
            (row.state === "bootstrapping" && row.owner_epoch === 0)
              ? '{"kind":"unavailable"}'
              : null,
        }),
      );
      expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 40,
      });
      expect(
        upgraded.prepare("SELECT * FROM worker_environments ORDER BY environment_id").all(),
      ).toEqual(expected);
      fixture.invalidate();
      expect(() => fixture.open(source)).toThrow(/newer|version.*40/iu);
      const reopened = fixture.open(stateEngineSchema);
      expect(
        reopened.prepare("SELECT * FROM worker_environments ORDER BY environment_id").all(),
      ).toEqual(expected);
    });
  });
});
