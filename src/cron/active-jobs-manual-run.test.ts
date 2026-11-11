// Exercise the manual producer's native mark/clear pair (7d1575b5df, #60310).

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { isCronJobActive, resetCronActiveJobs } from "./active-jobs.js";
import { cronTestJob } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-active-jobs-manual-run-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});
let activeCron: CronService;
afterEach(() => activeCron?.stop());

type IsolatedRunResult = Awaited<ReturnType<CronServiceDeps["runIsolatedAgentJob"]>>;

function createManualIsolatedJob(id: string, timeoutSeconds?: number): CronJob {
  const now = Date.parse("2025-12-13T17:00:00.000Z");
  return cronTestJob({
    id,
    schedule: { kind: "cron", expr: "0 18 * * *", tz: "UTC" },
    payload: { kind: "agentTurn", message: "hi", ...(timeoutSeconds ? { timeoutSeconds } : {}) },
    delivery: { mode: "none" },
    state: { nextRunAtMs: now + 3_600_000 },
  });
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
  activeCron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: () => {},
    runIsolatedAgentJob: async () => {
      entered.resolve();
      return await release.promise;
    },
    ...overrides,
  });
  return { cron: activeCron, entered, release };
}

beforeEach(resetCronActiveJobs);

it.each([false, true])("clears a manual run's active marker (throws=%s)", async (fails) => {
  const jobId = "manual-isolated";
  const { cron, entered, release } = await createManualRunHarness([createManualIsolatedJob(jobId)]);
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
});

it("sends one setup-timeout notification when concurrent manual runs both stall before runner start", async () => {
  const jobIds = ["manual-setup-timeout-first", "manual-setup-timeout-second"] as const;
  const bothStarted = createDeferred();
  const onIsolatedAgentSetupTimeout = vi.fn();
  let startedCount = 0;
  const { cron } = await createManualRunHarness(
    jobIds.map((id) => createManualIsolatedJob(id, 120)),
    {
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: async () => {
        startedCount += 1;
        if (startedCount === 2) {
          bothStarted.resolve();
        }
        return await new Promise<never>(() => {});
      },
    },
  );

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
});
