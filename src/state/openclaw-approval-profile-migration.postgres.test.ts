import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { createPostgresEngineTestFixture } from "../infra/database-engine/engine-store.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!connection)("PostgreSQL approval requester profile migration", () => {
  it("preserves predecessor approvals with unknown profiles and persists new trusted profiles", () => {
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
      const upgraded = fixture.open(stateEngineSchema);
      expect(upgraded.prepare("SELECT * FROM operator_approvals").all()).toEqual(
        before.map((row) => Object.assign({}, row, { requested_by_profile_id: null })),
      );
      expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      upgraded
        .prepare("UPDATE operator_approvals SET requested_by_profile_id = ? WHERE approval_id = ?")
        .run("trusted-profile", "original");
      fixture.invalidate();
      expect(() => fixture.open(source)).toThrow(
        new RegExp(`minimum reader ${OPENCLAW_STATE_SCHEMA_VERSION}.*supports 40`, "iu"),
      );
      const reopened = fixture.open(stateEngineSchema);
      expect(
        reopened.prepare("SELECT cursor_id, requested_by_profile_id FROM operator_approvals").get(),
      ).toEqual({ cursor_id: 7, requested_by_profile_id: "trusted-profile" });
    });
  });
});
