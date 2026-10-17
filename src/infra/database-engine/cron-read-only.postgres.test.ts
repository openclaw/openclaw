import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { loadLegacyCronRepairState } from "../../commands/doctor/cron/legacy-repair.js";
import { assertCronStateSchemaSupported } from "../../commands/doctor/cron/schema-safety.js";
import { saveCronJobsStore } from "../../cron/store.js";
import {
  inspectCronJobsReadOnly,
  loadCronJobsStoreWithConfigJobsReadOnly,
} from "../../cron/store/read-only.js";
import type { CronStoreFile } from "../../cron/types.js";
import { withArtifactPreservingStateReads } from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("PostgreSQL cron read-only owner", () => {
  it("loads jobs and Doctor inventory through PostgreSQL while retaining an anchor-only local store", async () => {
    const prefix = `cron_read_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    try {
      await withOpenClawTestState({ label: "postgres-cron-read-only" }, async (state) => {
        installDatabaseEngineSelection({
          effectiveEngines: resolveDatabaseFamilyEngines({
            database: { engine: "sqlite", families: { state: { engine: "postgres" } } },
          }),
          postgres: { connection: connection!, schemaPrefix: prefix },
        });
        const storePath = state.statePath("cron", "jobs.json");
        const store: CronStoreFile = {
          version: 1,
          jobs: [
            {
              id: "postgres-read-only",
              name: "persisted PostgreSQL job",
              enabled: true,
              agentId: "main",
              createdAtMs: 1,
              updatedAtMs: 2,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "synthetic event" },
              state: { nextRunAtMs: 60_001 },
            },
          ],
        };
        await saveCronJobsStore(storePath, store);
        await closeStateDatabaseForTest();
        withEngineStoreAdmission(() => assertCronStateSchemaSupported(state.env));
        const repairState = await loadLegacyCronRepairState({
          cfg: {},
          storePath,
          env: state.env,
          readOnly: true,
        });
        expect(repairState?.ownerRows).toEqual([
          expect.objectContaining({ job_id: "postgres-read-only", agent_id: "main" }),
        ]);
        for (const preserveArtifacts of [false, true]) {
          const read = () => loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
          const loaded = await (preserveArtifacts
            ? withArtifactPreservingStateReads(read)
            : read());
          expect(loaded.store).toEqual(store);
          expect(loaded.invalidConfigRows).toEqual([]);
        }
        expect(await inspectCronJobsReadOnly(state.env)).toEqual([
          expect.objectContaining({ id: "postgres-read-only", definition: expect.any(Object) }),
        ]);
        using anchor = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(state.env), {
          readOnly: true,
        });
        expect(
          anchor.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
        ).toEqual([{ name: "openclaw_engine_anchor" }]);
      });
    } finally {
      await closeStateDatabaseForTest();
      resetDatabaseEngineSelectionForTest();
      try {
        const schemas = await client.query<{ schema_name: string }>(
          "SELECT schema_name FROM information_schema.schemata WHERE starts_with(schema_name, $1)",
          [`${prefix}_`],
        );
        for (const { schema_name: schema } of schemas.rows) {
          await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
      } finally {
        await client.end();
      }
    }
  });
});
