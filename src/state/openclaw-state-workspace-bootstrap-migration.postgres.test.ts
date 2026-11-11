import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { createPostgresEngineTestFixture } from "../infra/database-engine/engine-store.test-support.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);

const column = /\n {2}"bootstrap_deferred" bigint,/u;
// Both exact v39 shapes: sealed before #196392 (absent) or bootstrapped from its first-use DDL.
const v39Absent = stateEngineSchema.postgres!.replace(column, "");
const v39Present = stateEngineSchema.postgres!;

function createV39Fixture(postgres: string, deferred: number | null) {
  const source = { ...stateEngineSchema, postgres, version: 39, postgresMigrations: [] };
  const fixture = createPostgresEngineTestFixture({
    directory: dirs.make("workspace-bootstrap-upgrade-"),
    connection: connection!,
    schemaPrefix: "workspace_bootstrap_upgrade_test",
    schema: source,
  });
  const original = fixture.open();
  const deferral = postgres.includes('"bootstrap_deferred"');
  original.runTransaction(() => {
    original.exec(`INSERT INTO schema_meta (meta_key,role,schema_version,agent_id,created_at,updated_at)
      VALUES ('primary','global',39,NULL,1,1);
      INSERT INTO config_machine_state VALUES ('state.schema.contentVersion','39',1);
      INSERT INTO workspace_setup_state (workspace_key,workspace_path,version,bootstrap_seeded_at,updated_at${deferral ? ",bootstrap_deferred" : ""})
      VALUES ('retained','/fixture/workspace',1,'2026-11-10T00:00:00.000Z',1${deferral ? `,${deferred ?? "NULL"}` : ""});`);
  });
  fixture.invalidate();
  return { fixture, source };
}

describe.skipIf(!connection)("PostgreSQL workspace bootstrap deferral migration", () => {
  it.each([
    ["absent", v39Absent, null],
    ["present", v39Present, 1],
  ] as const)(
    "upgrades a v39 store with the column %s, keeps its setup rows, and refuses the old reader",
    (_shape, postgres, deferred) => {
      expect(v39Absent).not.toBe(v39Present);
      withEngineStoreAdmission(() => {
        const { fixture: v39, source } = createV39Fixture(postgres, deferred);
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
            bootstrap_deferred: deferred,
          },
        ]);
        fixture.invalidate();
        expect(() => fixture.open(source)).toThrow(/newer|version/iu);
      });
    },
  );

  it.each(["integer", "bigint DEFAULT 0", "bigint NOT NULL DEFAULT 0"])(
    "still refuses a v39 store whose bootstrap_deferred column is %s",
    (definition) => {
      const drifted = v39Present.replace(column, `\n  "bootstrap_deferred" ${definition},`);
      expect(drifted).not.toBe(v39Present);
      withEngineStoreAdmission(() => {
        const { fixture: v39 } = createV39Fixture(drifted, 0);
        using fixture = v39;
        expect(() => fixture.open(stateEngineSchema)).toThrow(/drift/iu);
      });
    },
  );
});
