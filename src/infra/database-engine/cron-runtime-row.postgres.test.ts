import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import { expect, it } from "vitest";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import type { CronScratchReadCommand } from "../../cron/scratch-contract.js";
import { readCronScratchSnapshotInDatabase } from "../../cron/scratch-read.kernel.js";
import { writeCronJobScratchInDatabase } from "../../cron/scratch-write.kernel.js";
import { loadCronRows, replaceCronRows, upsertCronJobRow } from "../../cron/store/row-codec.js";
import { finalizeCronRunsInWorker } from "../../cron/store/run-finalization.worker.js";
import {
  cancelCronRequestsInWorker,
  drainCronQueueInWorker,
  requestCronRunsInWorker,
} from "../../cron/store/run-queue.worker.js";
import { createCronScheduledRunId } from "../../cron/store/run-request-id.js";
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
    `preserves one-shot config, current scratch snapshots, and queue reconciliation on ${engine}`,
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
            const readScratch = (selector: CronScratchReadCommand["selector"]) =>
              readCronScratchSnapshotInDatabase(database.db, {
                type: "cron.scratch",
                storeKey,
                selector,
              });
            expect(
              readScratch({ kind: "job", jobId: "missing-job", createdAtMsFallback: 1 }),
            ).toBeUndefined();
            expect(readScratch({ kind: "heartbeat", agentId: "missing-monitor" })).toBeUndefined();

            runOpenClawStateWriteTransaction(
              ({ db }) => {
                upsertCronJobRow(db, storeKey, { ...job, id: "heartbeat-monitor" }, 1);
                // Current writers no longer create legacy heartbeat definitions.
                db.prepare(
                  "UPDATE cron_jobs SET declaration_key = ?, payload_kind = ?, job_json = ? WHERE store_key = ? AND job_id = ?",
                ).run(
                  "heartbeat:main",
                  "heartbeat",
                  JSON.stringify({
                    ...job,
                    id: "heartbeat-monitor",
                    payload: { kind: "heartbeat" },
                  }),
                  storeKey,
                  "heartbeat-monitor",
                );
              },
              { database, env: state.env },
            );
            const selectors = [
              { kind: "job", jobId: job.id, createdAtMsFallback: 1 },
              { kind: "heartbeat", agentId: "main" },
            ] satisfies CronScratchReadCommand["selector"][];
            for (const selector of selectors) {
              const jobId = selector.kind === "job" ? selector.jobId : "heartbeat-monitor";
              const identity = {
                jobId,
                ...(selector.kind === "job" ? { configRevision: expect.any(String) } : {}),
              };
              expect(readScratch(selector)).toEqual({
                ...identity,
                state: { currentRevision: 0 },
              });
              for (const [content, expectedRevision] of [
                ["synthetic scratch", 0],
                [null, 1],
              ] as const) {
                runOpenClawStateWriteTransaction(
                  ({ db }) =>
                    writeCronJobScratchInDatabase(db, {
                      storeKey,
                      jobId,
                      content,
                      expectedRevision,
                      nowMs: 10,
                    }),
                  { database, env: state.env },
                );
                const revision = expectedRevision + 1;
                expect(readScratch(selector)).toEqual({
                  ...identity,
                  state: {
                    currentRevision: revision,
                    ...(content === null
                      ? {}
                      : { scratch: { content, revision, updatedAtMs: 10 } }),
                  },
                });
              }
            }
            runOpenClawStateWriteTransaction(
              ({ db }) =>
                db
                  .prepare("UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?")
                  .run("{malformed", storeKey, job.id),
              { database, env: state.env },
            );
            expect(
              readScratch({ kind: "job", jobId: job.id, createdAtMsFallback: 1 }),
            ).toBeUndefined();
            const queueNow = 1_000;
            const queueStoreKey = "queue";
            const foreignStoreKey = "foreign-queue";
            const queueJobs = ["blocker", "z-first", "a-second", "cancelled", "omitted"].map(
              (id): CronStoredJob =>
                Object.assign({}, job, {
                  id,
                  agentId: "main",
                  state: { nextRunAtMs: queueNow },
                }),
            );
            const foreignJob = { ...queueJobs[4]!, id: "foreign-cancelled" };
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                replaceCronRows(db, queueStoreKey, { version: 1, jobs: queueJobs });
                replaceCronRows(db, foreignStoreKey, { version: 1, jobs: [foreignJob] });
              },
              { database, env: state.env },
            );
            runWithSqliteWorkerStateContext(
              { environment: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir } },
              () => {
                const scheduled = (key: string, queuedJob: CronStoredJob) => ({
                  receiptId: createCronScheduledRunId(key, queuedJob.id, queueNow),
                  jobId: queuedJob.id,
                  configRevision: resolveCronJobConfigRevision(queuedJob),
                  scheduledSlotMs: queueNow,
                  mode: "scheduled" as const,
                });
                const requests = queueJobs.map((queuedJob) => scheduled(queueStoreKey, queuedJob));
                const [blocker, first, second, cancelled, omitted] = requests;
                const foreign = scheduled(foreignStoreKey, foreignJob);
                const request = (key: string, entries: typeof requests) =>
                  requestCronRunsInWorker(database, {
                    storeKey: key,
                    nowMs: queueNow,
                    requests: entries,
                  });
                const drain = (
                  contexts: typeof requests,
                  maxConcurrentRuns: number,
                  nowMs = queueNow + 3,
                ) =>
                  drainCronQueueInWorker(database, {
                    storeKey: queueStoreKey,
                    nowMs,
                    requests: contexts,
                    maxConcurrentRuns,
                  });
                request(queueStoreKey, [blocker!]);
                expect(
                  drain([], 1, queueNow + 1).launches.map(({ job: queuedJob }) => queuedJob.id),
                ).toEqual(["blocker"]);
                request(queueStoreKey, [second!, cancelled!, omitted!, first!]);
                request(foreignStoreKey, [foreign]);
                for (const [key, entries] of [
                  [queueStoreKey, [cancelled!, omitted!]],
                  [foreignStoreKey, [foreign]],
                ] as const) {
                  expect(
                    cancelCronRequestsInWorker(database, {
                      storeKey: key,
                      receiptIds: entries.map(({ receiptId }) => receiptId),
                      nowMs: queueNow + 2,
                      reason: "",
                    }).skipped,
                  ).toHaveLength(entries.length);
                }
                const withoutContexts = drain([], 2);
                const withContexts = drain([cancelled!, foreign], 3);
                expect(withoutContexts.launches.map(({ job: queuedJob }) => queuedJob.id)).toEqual([
                  "z-first",
                ]);
                expect(withContexts.launches.map(({ job: queuedJob }) => queuedJob.id)).toEqual([
                  "a-second",
                ]);
                expect(withoutContexts.skipped).toEqual([]);
                expect(
                  withContexts.skipped.map(({ runReceipt, error }) => [
                    runReceipt.receiptId,
                    error,
                  ]),
                ).toEqual([[cancelled!.receiptId, ""]]);
              },
            );
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
