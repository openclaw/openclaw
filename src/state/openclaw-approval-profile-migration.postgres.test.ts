import { createHash } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { createPostgresEngineTestFixture } from "../infra/database-engine/engine-store.test-support.js";
import {
  readPostgresSchema,
  recordPostgresSchema,
} from "../infra/database-engine/postgres-schema.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!connection)("PostgreSQL approval and worker loss migrations", () => {
  it("preserves exact v41 approval custody through a lazy fragment upgrade to v42", () => {
    withEngineStoreAdmission(() => {
      const migration = stateEngineSchema.postgresMigrations?.find((step) => step.version === 41);
      if (!migration) {
        throw new Error("Missing state41 migration");
      }
      const source = {
        ...stateEngineSchema,
        ...migration.fromSchema,
        version: 40,
        postgresMigrations: [],
      };
      const approvalSchema = {
        ...stateEngineSchema,
        ...migration.schema,
        version: 41,
        postgresMigrations: [migration],
      };
      using fixture = createPostgresEngineTestFixture({
        directory: dirs.make("approval-profile-upgrade-"),
        connection: connection!,
        schemaPrefix: "approval_profile_upgrade_test",
        schema: source,
      });
      const original = fixture.open();
      original.runTransaction(() => {
        original.exec(`INSERT INTO schema_meta (meta_key,role,schema_version,created_at,updated_at)
          VALUES ('primary','global',40,1,1);
          INSERT INTO operator_approvals (cursor_id, approval_id, resolution_ref, kind, status,
            presentation_json, requested_by_device_id, requested_by_client_id,
            reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
            created_at_ms, expires_at_ms, updated_at_ms)
          VALUES (7, 'original', '${"r".repeat(43)}', 'exec', 'pending', '{}', 'device', 'client',
            '[]', '[]', 'epoch', 1, 100, 1);`);
      });
      const before = original.prepare("SELECT * FROM operator_approvals").all();
      fixture.invalidate();
      const upgraded = fixture.open(approvalSchema);
      expect(upgraded.prepare("SELECT * FROM operator_approvals").all()).toEqual(
        before.map((row) => Object.assign({}, row, { requested_by_profile_id: null })),
      );
      expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 41,
      });
      upgraded
        .prepare("UPDATE operator_approvals SET requested_by_profile_id = ? WHERE approval_id = ?")
        .run("trusted-profile", "original");
      // Match the committed eager and lazy v41 artifacts at main 2e8c1ad0aa97.
      const loss = stateEngineSchema.postgresMigrations?.find((step) => step.version === 42);
      const repositoryFragment = approvalSchema.postgresFragments?.find((fragment) =>
        fragment.tables.includes("session_repository_workspaces"),
      );
      if (!loss || !repositoryFragment) {
        throw new Error("Missing state42 migration or v41 repository fragment");
      }
      expect(createHash("sha256").update(approvalSchema.postgres).digest("hex")).toBe(
        "ce5a488946062cdbc20d6fd46c35382d9648c0e4b69fb7b7b5dbc8d70c4eee2c",
      );
      expect(createHash("sha256").update(repositoryFragment.sql).digest("hex")).toBe(
        "8115ea419dc4933624e1d3a2137e67f32b6b5b337a89296e102fe5839b8ed95e",
      );
      expect(loss.fromSchema).toEqual(migration.schema);
      upgraded.runTransaction(() => {
        // This is an installed v41 catalog, including its historical lazy fragment and seal.
        upgraded.exec(repositoryFragment.sql);
        recordPostgresSchema(upgraded, upgraded.schema, approvalSchema);
        upgraded.exec(`INSERT INTO session_repository_workspaces
          (workspace_id, agent_id, session_key, url, branch, revision, created_at_ms, updated_at_ms)
          VALUES ('11111111-1111-4111-8111-111111111111', 'main', 'agent:main:kept', 'https://github.com/example/project.git', 'saved/kept', 7, 1, 1);
          INSERT INTO worker_session_placements
          (session_id, agent_id, session_key, state, created_at_ms, updated_at_ms, state_changed_at_ms)
          VALUES ('retained-session', 'main', 'agent:main:kept', 'local', 1, 1, 1);`);
      });
      const repository = upgraded.prepare("SELECT * FROM session_repository_workspaces").all();
      const placements = upgraded.prepare("SELECT * FROM worker_session_placements").all();
      fixture.invalidate();
      expect(() => fixture.open(source)).toThrow(/newer|version.*41/iu);
      const current = fixture.open(stateEngineSchema);
      const { metadata } = readPostgresSchema(current, current.schema, stateEngineSchema.id);
      expect(metadata.version).toBe(42);
      expect(metadata.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(current.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 42,
      });
      expect(
        current
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
          )
          .get(),
      ).toEqual({ value_json: "42" });
      expect(current.prepare("SELECT * FROM session_repository_workspaces").all()).toEqual(
        repository.map((row) => Object.assign({}, row, { recovery_json: null })),
      );
      expect(current.prepare("SELECT * FROM worker_session_placements").all()).toEqual(
        placements.map((row) => Object.assign({}, row, { confirmed_loss_recovery_json: null })),
      );
      expect(
        current.prepare("SELECT cursor_id, requested_by_profile_id FROM operator_approvals").get(),
      ).toEqual({ cursor_id: 7, requested_by_profile_id: "trusted-profile" });
    });
  });
});
