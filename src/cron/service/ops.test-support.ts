import { vi } from "vitest";
import { observeCronJobCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import type { CronJob, CronJobExecutionResult } from "../types.js";
import { run } from "./ops-run.js";
import type { CronEvent, CronServiceDeps } from "./state.js";

export function createOkIsolatedCronStateFactory(log: CronServiceDeps["log"]) {
  return function createOkIsolatedCronState(params: {
    storePath: string;
    now: number;
    summary?: string;
    onEvent?: (event: CronEvent) => void;
    triggersEnabled?: boolean;
  }) {
    return createCronRegressionState({
      log,
      storePath: params.storePath,
      nowMs: () => params.now,
      ...(params.triggersEnabled ? { cronConfig: { triggers: { enabled: true } } } : {}),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        delivered: true,
        ...(params.summary === undefined ? {} : { summary: params.summary }),
      })),
      ...(params.onEvent ? { onEvent: params.onEvent } : {}),
    });
  };
}

type RegressionParams = Parameters<typeof createCronRegressionState>[0];
type Runner = RegressionParams["runIsolatedAgentJob"];

export function createHeldCronRunner() {
  const started = createDeferred();
  const release = createDeferred<CronJobExecutionResult>();
  const runner = vi.fn<Runner>(async () => {
    started.resolve();
    return await release.promise;
  });
  return { started: started.promise, release, runner };
}

export async function createCronRunFixture(
  storePath: string,
  job: CronJob,
  overrides: Partial<Omit<RegressionParams, "storePath">> = {},
) {
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const clock = { now: job.createdAtMs };
  const runIsolatedAgentJob =
    overrides.runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const }));
  const state = createCronRegressionState({
    storePath,
    nowMs: () => clock.now,
    ...overrides,
    runIsolatedAgentJob,
  });
  return {
    store: { storePath },
    state,
    clock,
    runIsolatedAgentJob,
    readJob: async () => (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id),
    receipt: () =>
      openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
        )
        .get(cronStoreKey(storePath), job.id) as { status: string } | undefined,
  };
}

export async function createBlockedCronRun(
  storePath: string,
  job: CronJob,
  overrides: Partial<Omit<RegressionParams, "storePath">> = {},
) {
  const blockers = Array.from({ length: 8 }, (_, index) =>
    createDueIsolatedJob({
      id: `${job.id}-blocker-${index}`,
      nowMs: job.createdAtMs,
      nextRunAtMs: job.createdAtMs + 3_600_000,
    }),
  );
  await saveCronStore(storePath, { version: 1, jobs: [...blockers, job] });
  const started = createDeferred();
  const releaseActive = createDeferred<Awaited<ReturnType<Runner>>>();
  let count = 0;
  const runIsolatedAgentJob = vi.fn<Runner>(async (input) => {
    if (blockers.some((blocker) => blocker.id === input.job.id)) {
      if (++count === blockers.length) {
        started.resolve();
      }
      return await releaseActive.promise;
    }
    return overrides.runIsolatedAgentJob
      ? await overrides.runIsolatedAgentJob(input)
      : { status: "ok" };
  });
  const state = createCronRegressionState({
    ...overrides,
    storePath,
    nowMs: overrides.nowMs ?? (() => job.createdAtMs),
    runIsolatedAgentJob,
  });
  const activeRun = Promise.all(blockers.map((blocker) => run(state, blocker.id, "force")));
  await started.promise;
  const queued = createDeferred();
  observeCronJobCommits(job.id, ({ queuedAtMs }) => {
    if (queuedAtMs !== undefined) {
      queued.resolve();
    }
  });
  return {
    storePath,
    state,
    runIsolatedAgentJob,
    activeRun,
    releaseActive,
    queued: queued.promise,
    readJob: async () => (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id),
    readReceipt: () => inspectActiveCronRunReceipt({ storePath, jobId: job.id }),
    targetCalls: () => runIsolatedAgentJob.mock.calls.filter(([input]) => input.job.id === job.id),
    finishActive: async (result: Awaited<ReturnType<Runner>> = { status: "ok" }) => {
      releaseActive.resolve(result);
      await activeRun;
    },
  };
}
