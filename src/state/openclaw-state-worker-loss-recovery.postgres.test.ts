import { getEnvironmentData } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { createPostgresEngineTestFixture } from "../infra/database-engine/engine-store.test-support.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterEach);
const repository = "session_repository_workspaces";
describe.skipIf(!connection)("PostgreSQL shared-state v41 migration", () => {
  it.each([false, true])(
    "migrates v40 placement and optional repository rows (present=%s)",
    (present) => {
      withEngineStoreAdmission(() => {
        const predecessor = expectDefined(
          stateEngineSchema.postgresMigrations?.find(({ version }) => version === 41)?.fromSchema,
          "v41 migration predecessor",
        );
        const source = {
          ...stateEngineSchema,
          ...predecessor,
          // Model an already-used v40 repository fragment without changing its DDL.
          postgresFragments: predecessor.postgresFragments?.map((fragment) =>
            present && fragment.tables.includes(repository)
              ? Object.assign({}, fragment, { activation: "version-additive" as const })
              : fragment,
          ),
          version: 40,
          postgresMigrations: [],
        };
        using fixture = createPostgresEngineTestFixture({
          directory: directories.make("worker-loss-upgrade-"),
          connection: connection!,
          schemaPrefix: "worker_loss_v40_upgrade",
          schema: source,
        });
        const old = fixture.open();
        old.exec(`INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
        VALUES ('primary', 'global', 40, 1, 1);
        INSERT INTO worker_session_placements
          (session_id, agent_id, session_key, state, transition_generation, created_at_ms, updated_at_ms, state_changed_at_ms)
        VALUES ('retained', 'main', 'agent:main:retained', 'local', 8, 1, 2, 2);`);
        const placement = old.prepare("SELECT * FROM worker_session_placements").get();
        let savedRepository;
        let savedRepositoryDdl;
        if (present) {
          old.exec(`INSERT INTO session_repository_workspaces
          (workspace_id, agent_id, session_key, url, branch, revision, created_at_ms, updated_at_ms)
          VALUES ('11111111-1111-4111-8111-111111111111', 'main', 'agent:main:retained', 'https://example.invalid/repo.git', 'saved', 7, 1, 2);`);
          savedRepository = old.prepare("SELECT * FROM session_repository_workspaces").get();
          savedRepositoryDdl = old
            .prepare(
              "SELECT attname, atttypid, attnotnull FROM pg_attribute WHERE attrelid = to_regclass(?) AND attnum > 0 ORDER BY attnum",
            )
            .all(repository);
          expect(savedRepositoryDdl.length).toBeGreaterThan(0);
        }
        fixture.invalidate();
        const upgraded = fixture.open(stateEngineSchema);
        expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
          schema_version: 41,
        });
        expect(upgraded.prepare("SELECT * FROM worker_session_placements").get()).toEqual({
          ...placement,
          confirmed_loss_recovery_json: null,
        });
        if (present) {
          expect(upgraded.prepare("SELECT * FROM session_repository_workspaces").get()).toEqual(
            savedRepository,
          );
          expect(
            upgraded
              .prepare(
                "SELECT attname, atttypid, attnotnull FROM pg_attribute WHERE attrelid = to_regclass(?) AND attnum > 0 ORDER BY attnum",
              )
              .all(repository),
          ).toEqual(savedRepositoryDdl);
        } else {
          expect(
            upgraded.prepare("SELECT to_regclass(?) IS NULL AS absent").get(repository),
          ).toEqual({ absent: 1 });
        }
        fixture.invalidate();
        expect(() => fixture.open(source)).toThrow(/PostgreSQL state schema 41 is newer/);
      });
    },
  );
});
