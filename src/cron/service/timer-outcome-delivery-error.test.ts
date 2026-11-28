import { expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { resolveCronRunErrorReason } from "../run-error-reason.js";
import type { CronJob } from "../types.js";
import type { CronJobRunResult } from "./timer-execution-timeout.js";
import { authorCronRunCompletion } from "./timer-job-runner.js";
import { applyJobResult } from "./timer-outcomes.js";

const ENDED_AT = Date.parse("2026-07-18T12:00:00.000Z");
const STARTED_AT = ENDED_AT - 1_000;
const EXECUTION_ERROR = "SYNTHETIC_PROVIDER_RATE_LIMIT";

function makeState() {
  return createCronRegressionState({
    storePath: "/tmp/cron-delivery-error-timer/jobs.json",
    nowMs: () => ENDED_AT,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function makeJob(): CronJob {
  return makeCronJob({
    delivery: { mode: "announce" },
    state: { nextRunAtMs: STARTED_AT },
  });
}

function complete(job: CronJob, result: Partial<CronJobRunResult>) {
  const state = makeState();
  applyJobResult(
    state,
    job,
    {
      status: "error",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      ...result,
      errorReason: resolveCronRunErrorReason(result.error),
    },
    { deferredNotifications: [] },
  );
}

it("keeps an execution-only failure out of the delivery diagnostics", () => {
  const job = makeJob();

  complete(job, {
    error: EXECUTION_ERROR,
    delivered: false,
    deliveryAttempted: false,
  });

  expect(job.state.lastError).toBe(EXECUTION_ERROR);
  expect(job.state.lastDeliveryStatus).toBe("not-delivered");
  expect(job.state.lastDeliveryError).toBeUndefined();
});

it("reports the run completion of an execution-only failure the same way", () => {
  const job = makeJob();

  const completion = authorCronRunCompletion(job, {
    status: "error",
    error: EXECUTION_ERROR,
    delivered: false,
    deliveryAttempted: false,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
  });

  expect(completion.deliveryState.status).toBe("not-delivered");
  expect(completion.deliveryState.error).toBeUndefined();
});

it("still reports a delivery failure that the dispatcher recorded", () => {
  const job = makeJob();

  complete(job, {
    error: EXECUTION_ERROR,
    delivered: false,
    deliveryAttempted: true,
    deliveryError: "announce target rejected the send",
  });

  expect(job.state.lastDeliveryStatus).toBe("not-delivered");
  expect(job.state.lastDeliveryError).toBe("announce target rejected the send");
});
