import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { createPostgresEngineTestFixture } from "../infra/database-engine/engine-store.test-support.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);

// A v39 store sealed before Template bootstrap deferral has no bootstrap_deferred column.
const v39Postgres = stateEngineSchema.postgres!.replace(/\n {2}"bootstrap_deferred" bigint,/u, "");

function createV39Fixture(postgres: string) {
  const source = { ...stateEngineSchema, postgres, version: 39, postgresMigrations: [] };
  const fixture = createPostgresEngineTestFixture({
    directory: dirs.make("workspace-bootstrap-upgrade-"),
    connection: connection!,
    schemaPrefix: "workspace_bootstrap_upgrade_test",
    schema: source,
  });
  const original = fixture.open();
  original.runTransaction(() => {
    original.exec(`INSERT INTO schema_meta (meta_key,role,schema_version,agent_id,created_at,updated_at)
      VALUES ('primary','global',39,NULL,1,1);
      INSERT INTO config_machine_state VALUES ('state.schema.contentVersion','39',1);
      INSERT INTO workspace_setup_state (workspace_key,workspace_path,version,bootstrap_seeded_at,updated_at)
      VALUES ('retained','/fixture/workspace',1,'2026-11-10T00:00:00.000Z',1);`);
  });
  fixture.invalidate();
  return { fixture, source };
}

describe.skipIf(!connection)("PostgreSQL workspace bootstrap deferral migration", () => {
  it("adds bootstrap_deferred to a v39 store, keeps its setup rows, and refuses the old reader", () => {
    expect(v39Postgres).not.toBe(stateEngineSchema.postgres);
    withEngineStoreAdmission(() => {
      const { fixture: v39, source } = createV39Fixture(v39Postgres);
      using fixture = v39;
      const upgraded = fixture.open(stateEngineSchema);
      expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: stateEngineSchema.version,
      });
      expect(
        upgraded
          .prepare(
            "SELECT workspace_path, bootstrap_seeded_at, bootstrap_deferred FROM workspace_setup_state",
          )
          .all(),
      ).toEqual([
        {
          workspace_path: "/fixture/workspace",
          bootstrap_seeded_at: "2026-11-10T00:00:00.000Z",
          bootstrap_deferred: null,
        },
      ]);
      fixture.invalidate();
      expect(() => fixture.open(source)).toThrow(/newer|version/iu);
    });
  });

  it("still refuses a v39 store whose bootstrap_deferred column drifted", () => {
    const drifted = v39Postgres.replace(
      /\n {2}"attestation_updated_at_ms" bigint,/u,
      '\n  "attestation_updated_at_ms" bigint,\n  "bootstrap_deferred" text COLLATE "C",',
    );
    withEngineStoreAdmission(() => {
      const { fixture: v39 } = createV39Fixture(drifted);
      using fixture = v39;
      expect(() => fixture.open(stateEngineSchema)).toThrow(/drift/iu);
    });
  });
});
