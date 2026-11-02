import { describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { resolveCronRunErrorReason } from "../run-error-reason.js";
import type { CronServiceDeps } from "./state.js";
import { executeJobCore } from "./timer-execution.js";
import { applyJobResult } from "./timer-outcomes.js";
import { resolveTransientCronRetryDecision } from "./timer-trigger.js";

const startedAt = Date.parse("2026-08-20T12:00:00.000Z");
const endedAt = startedAt + 500;

function makeJob(scheduleKind: "at" | "every") {
  return makeCronJob({
    schedule:
      scheduleKind === "at"
        ? { kind: "at", at: new Date(startedAt).toISOString() }
        : { kind: "every", everyMs: 60 * 60_000, anchorMs: startedAt },
    state: { runningAtMs: startedAt, nextRunAtMs: startedAt },
  });
}

async function executeAndApply(job: ReturnType<typeof makeJob>, deps: Partial<CronServiceDeps>) {
  const state = createCronRegressionState({
    storePath: "/tmp/cron-retry-classification.json",
    nowMs: () => endedAt,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...deps,
  });
  state.store = { version: 1, jobs: [job] };
  const result = await executeJobCore(state, job);
  applyJobResult(
    state,
    job,
    {
      ...result,
      errorReason: resolveCronRunErrorReason(
        result.error,
        result.provider,
        result.errorClassification,
      ),
      executionStarted: true,
      startedAt,
      endedAt,
    },
    { deferredNotifications: [] },
  );
}

describe("resolveTransientCronRetryDecision", () => {
  it.each(["at", "every"] as const)(
    "does not retry an incidental numeric command failure for %s jobs",
    async (scheduleKind) => {
      const job = makeJob(scheduleKind);
      job.payload = { kind: "command", argv: ["local-task"] };
      await executeAndApply(job, {
        runCommandJob: vi.fn(async () => ({
          status: "error" as const,
          error: "529 lines of output",
          errorClassification: { kind: "permanent" as const },
        })),
      });
      expect(job.state.lastErrorReason).toBeUndefined();
      expect(job.enabled).toBe(scheduleKind === "every");
      expect(job.state.nextRunAtMs).toBe(
        scheduleKind === "every" ? startedAt + 60 * 60_000 : undefined,
      );
    },
  );

  it.each(["at", "every"] as const)(
    "retries provider-attributed overload for %s jobs",
    async (scheduleKind) => {
      const job = makeJob(scheduleKind);
      await executeAndApply(job, {
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "error" as const,
          error: "HTTP 529",
          provider: "provider-fixture",
        })),
      });
      expect(job.state.lastErrorReason).toBe("overloaded");
      expect(job.enabled).toBe(true);
      expect(job.state.nextRunAtMs).toBe(endedAt + 30_000);
    },
  );

  it("keeps permanent-looking and transient provider classifications distinct", () => {
    const error = "HTTP 429: all available credits have been exhausted";

    expect(
      resolveTransientCronRetryDecision({
        error,
        errorClassification: { kind: "reason", reason: "billing" },
        consecutiveErrors: 1,
      }),
    ).toEqual({
      retryable: false,
      consecutiveErrors: 1,
      reason: "permanent error",
    });

    expect(
      resolveTransientCronRetryDecision({
        error,
        errorClassification: { kind: "reason", reason: "rate_limit" },
        consecutiveErrors: 1,
      }),
    ).toMatchObject({
      retryable: true,
      consecutiveErrors: 1,
      retryCategory: "rate_limit",
      reason: "transient retry",
    });
  });
});
