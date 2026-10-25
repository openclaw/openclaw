import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import { expect, it } from "vitest";
import { loadCronRows, replaceCronRows } from "../../cron/store/row-codec.js";
import { finalizeCronRunsInWorker } from "../../cron/store/run-finalization.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "../../cron/store/runtime-rows.kernel.js";
import type { CronStoredJob } from "../../cron/types.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runWithSqliteWorkerStateContext } from "../sqlite-worker-state-context.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

for (const engine of ["sqlite", "postgres"] as const) {
  it.skipIf(engine === "postgres" && !connection)(
    `commits one-shot completion and boolean enablement without losing config on ${engine}`,
    async () => {
      const prefix = `cron_runtime_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      try {
        await withOpenClawTestState({ label: `cron-runtime-${engine}` }, async (state) => {
          installDatabaseEngineSelection({
            effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
            ...(engine === "postgres"
              ? { postgres: { connection: connection!, schemaPrefix: prefix } }
              : {}),
          });
          withEngineStoreAdmission(() => {
            const database = openOpenClawStateDatabase({ env: state.env });
            const job: CronStoredJob = {
              id: "one-shot",
              name: "synthetic one-shot",
              enabled: true,
              deleteAfterRun: false,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: { kind: "at", at: new Date(1_000).toISOString() },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "synthetic completion" },
              delivery: { mode: "none" },
              state: { nextRunAtMs: 1_000, runningAtMs: 1_000 },
            };
            const storeKey = "test";
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                replaceCronRows(db, storeKey, { version: 1, jobs: [job] });
                const definition: Record<string, unknown> = {
                  ...job,
                  authoredNote: { keep: true, nested: [1, "two"] },
                };
                delete definition.state;
                db.prepare(
                  "UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?",
                ).run(JSON.stringify(definition), storeKey, job.id);
              },
              { database, env: state.env },
            );
            const result = runWithSqliteWorkerStateContext(
              { environment: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir } },
              () =>
                finalizeCronRunsInWorker(database, {
                  storeKey,
                  snapshot: {
                    nowMs: 2_000,
                    defaultAgentId: "main",
                    outcomes: [
                      {
                        jobId: job.id,
                        job,
                        startedAt: 1_000,
                        endedAt: 2_000,
                        status: "ok",
                        completionStatus: "succeeded",
                        deliveryState: {
                          status: "not-requested",
                          failureNotification: { status: "not-requested" },
                        },
                        summary: "done",
                      },
                    ],
                  },
                }),
            );
            expect(result.outcome.eventPlans).toHaveLength(1);
            expect(
              database.db
                .prepare("SELECT status, terminal_summary FROM task_runs WHERE source_id = ?")
                .get(job.id),
            ).toEqual({ status: "succeeded", terminal_summary: "done" });
            const [completed] = loadCronRows(database.db, storeKey);
            expect(completed?.enabled).toBe(0);
            expect(JSON.parse(completed!.state_json)).toMatchObject({ lastRunStatus: "ok" });
            const completedConfig = JSON.parse(completed!.job_json);
            expect(completedConfig.enabled).toBe(false);
            expect(completedConfig.authoredNote).toEqual({ keep: true, nested: [1, "two"] });
            runOpenClawStateWriteTransaction(
              ({ db }) =>
                mutateCronRuntimeRowsInDatabase({
                  database: db,
                  storeKey,
                  jobIds: new Set([job.id]),
                  mutate: ({ jobs }) => {
                    jobs.get(job.id)!.enabled = true;
                    return { upsertJobIds: [job.id], value: undefined };
                  },
                }),
              { database, env: state.env },
            );
            const [resumed] = loadCronRows(database.db, storeKey);
            expect(resumed?.enabled).toBe(1);
            expect(JSON.parse(resumed!.job_json)).toMatchObject({
              enabled: true,
              authoredNote: { keep: true, nested: [1, "two"] },
            });
          });
          await closeStateDatabaseForTest();
        });
      } finally {
        await closeStateDatabaseForTest();
        resetDatabaseEngineSelectionForTest();
        if (engine === "postgres") {
          await withPostgresConnection(
            { connection: connection!, schemaPrefix: prefix },
            async (client) => {
              const schemas = await client.query<{ nspname: string }>(
                "SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)",
                [`${prefix}_`],
              );
              for (const { nspname } of schemas.rows) {
                await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
              }
            },
          );
        }
      }
    },
  );
}
