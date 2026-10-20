// Exercise the manual producer's native mark/clear pair (7d1575b5df, #60310).

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  advanceCronActiveJobGeneration,
  clearCronJobActive,
  isCronActiveJobMarkerCurrent,
  isCronJobActive,
  markCronJobActive,
  resetCronActiveJobs,
} from "./active-jobs.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-active-jobs-manual-run-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

type IsolatedRunResult = Awaited<ReturnType<CronServiceDeps["runIsolatedAgentJob"]>>;

function createManualIsolatedJob(id: string, timeoutSeconds?: number): CronJob {
  const now = Date.parse("2025-12-13T17:00:00.000Z");
  return {
    id,
    name: id.replaceAll("-", " "),
    enabled: true,
    createdAtMs: now - 3_600_000,
    updatedAtMs: now,
    schedule: { kind: "cron", expr: "0 18 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hi", ...(timeoutSeconds ? { timeoutSeconds } : {}) },
    delivery: { mode: "none" },
    state: { nextRunAtMs: now + 3_600_000 },
  };
}

async function createManualRunHarness(
  jobs: CronJob[],
  overrides: Partial<
    Pick<CronServiceDeps, "onIsolatedAgentSetupTimeout" | "runIsolatedAgentJob">
  > = {},
) {
  const store = await makeStorePath();
  await writeCronStoreSnapshot({ storePath: store.storePath, jobs });

  const entered = createDeferred();
  const release = createDeferred<IsolatedRunResult>();
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: () => {},
    requestHeartbeat: () => {},
    runIsolatedAgentJob: async () => {
      entered.resolve();
      return await release.promise;
    },
    ...overrides,
  });
  return { cron, entered, release, store };
}

async function expectManualRunClears(jobId: string, fails = false) {
  const { cron, entered, release, store } = await createManualRunHarness([
    createManualIsolatedJob(jobId),
  ]);
  try {
    await cron.start();
    const run = cron.run(jobId, "force");
    await entered.promise;
    expect(isCronJobActive(jobId)).toBe(true);
    if (fails) {
      release.reject(new Error("synthetic inner failure"));
    } else {
      release.resolve({ status: "ok", summary: "ok" });
    }
    await run;
    expect(isCronJobActive(jobId)).toBe(false);
  } finally {
    cron.stop();
    await store.cleanup();
  }
}

function expectReplacementSurvives(jobId: string, advanceGeneration = false) {
  const oldMarker = markCronJobActive(jobId);
  if (advanceGeneration) {
    advanceCronActiveJobGeneration();
  }
  const freshMarker = markCronJobActive(jobId);
  clearCronJobActive(jobId, oldMarker);
  expect(isCronJobActive(jobId)).toBe(true);
  clearCronJobActive(jobId, freshMarker);
  expect(isCronJobActive(jobId)).toBe(false);
}

beforeEach(resetCronActiveJobs);
afterEach(() => vi.useRealTimers());

it.each([false, true])("clears a manual run's active marker (throws=%s)", (fails) =>
  expectManualRunClears("manual-isolated", fails),
);

it.each([false, true])("preserves a replacement marker (restart=%s)", (restart) => {
  expectReplacementSurvives("manual-reuse", restart);
});

it("retires preserved main-session markers at the lifecycle cutoff", () => {
  const marker = markCronJobActive("manual-main-cutoff", { preserveAcrossGenerationAdvance: true });

  advanceCronActiveJobGeneration();

  expect(isCronActiveJobMarkerCurrent(marker)).toBe(true);

  resetCronActiveJobs();

  expect(isCronActiveJobMarkerCurrent(marker)).toBe(false);
  expect(isCronJobActive("manual-main-cutoff")).toBe(false);
});

it("sends one setup-timeout notification when concurrent manual runs both stall before runner start", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2025-12-13T17:00:00.000Z"));

  const jobIds = ["manual-setup-timeout-first", "manual-setup-timeout-second"] as const;
  const bothStarted = createDeferred();
  const onIsolatedAgentSetupTimeout = vi.fn();
  let startedCount = 0;
  const { cron, store } = await createManualRunHarness(
    jobIds.map((id) => createManualIsolatedJob(id, 120)),
    {
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: async ({ abortSignal }) => {
        startedCount += 1;
        if (startedCount === 2) {
          bothStarted.resolve();
        }
        abortSignal?.addEventListener("abort", () => undefined, { once: true });
        return await new Promise<never>(() => {});
      },
    },
  );

  try {
    await cron.start();

    const firstRun = cron.run(jobIds[0], "force");
    const secondRun = cron.run(jobIds[1], "force");
    await bothStarted.promise;

    await vi.advanceTimersByTimeAsync(60_100);
    await Promise.all([firstRun, secondRun]);

    expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledExactlyOnceWith({
      job: expect.objectContaining({ id: expect.stringMatching(/^manual-setup-timeout-/) }),
      error: expect.stringContaining("setup timed out before runner start"),
      timeoutMs: 60_000,
    });
    expect(jobIds.map(isCronJobActive)).toEqual([false, false]);
  } finally {
    cron.stop();
    await store.cleanup();
  }
});
