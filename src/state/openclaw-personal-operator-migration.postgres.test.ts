import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { createPostgresEngineTestFixture } from "../infra/database-engine/engine-store.test-support.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!connection)("PostgreSQL personal operator migration", () => {
  it("upgrades v40 without assigning legacy people and refuses an older reader", () => {
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
        directory: dirs.make("personal-operator-upgrade-"),
        connection: connection!,
        schemaPrefix: "personal_operator_upgrade_test",
        schema: source,
      });
      const original = fixture.open();
      original.runTransaction(() => {
        original.exec(`INSERT INTO schema_meta (meta_key,role,schema_version,created_at,updated_at)
          VALUES ('primary','global',40,1,1);
          INSERT INTO device_pairing_paired (device_id,public_key,created_at_ms,approved_at_ms)
          VALUES ('legacy','legacy-key',1,1);
          INSERT INTO config_machine_state VALUES ('unrelated','{"retained":true}',1);`);
      });
      fixture.invalidate();
      const upgraded = fixture.open(stateEngineSchema);
      const profileQuery =
        "SELECT operator_profile_id FROM device_pairing_paired WHERE device_id='legacy'";
      expect(upgraded.prepare(profileQuery).get()).toEqual({ operator_profile_id: null });
      expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 41,
      });
      expect(
        upgraded
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key='unrelated'")
          .get(),
      ).toEqual({ value_json: '{"retained":true}' });
      fixture.invalidate();
      expect(() => fixture.open(source)).toThrow(/newer|version.*41/iu);
      const reopened = fixture.open(stateEngineSchema);
      expect(reopened.prepare(profileQuery).get()).toEqual({ operator_profile_id: null });
    });
  });
});
