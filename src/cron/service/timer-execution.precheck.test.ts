import { describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronJobPrecheckResult } from "../job-precheck.js";
import type { CronStoredJob } from "../types.js";
import type { CronServiceDeps } from "./state.js";
import { executeJobCore } from "./timer-execution.js";

const precheck = {
  command: "inbox-has-mail",
  timeoutSeconds: 30,
  workExitCodes: [0],
  noWorkExitCodes: [2],
};

function job(): CronStoredJob {
  return makeCronJob({
    payload: { kind: "agentTurn", message: "Process new mail" },
    precheck,
    trigger: { script: "json({ fire: true })" },
  });
}

function makeState(overrides: Partial<CronServiceDeps> = {}) {
  return createCronRegressionState({
    storePath: "/tmp/cron-precheck.json",
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    evaluateCronTrigger: vi.fn(async () => ({ kind: "evaluated" as const, fire: true })),
    ...overrides,
  });
}

describe("executeJobCore precheck", () => {
  it("skips the trigger and payload when the probe reports no work", async () => {
    const state = makeState({
      runJobPrecheck: vi.fn(
        async () => ({ kind: "no-work", exitCode: 2 }) as CronJobPrecheckResult,
      ),
    });

    await expect(executeJobCore(state, job())).resolves.toEqual({
      status: "skipped",
      summary: "precheck-no-work",
      executionStarted: false,
      delivered: false,
      deliveryAttempted: false,
    });
    expect(state.deps.evaluateCronTrigger).not.toHaveBeenCalled();
    expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("records a denial and does not start the payload", async () => {
    const state = makeState({
      runJobPrecheck: vi.fn(
        async () => ({ kind: "denied", error: "exec denied: host=gateway security=deny" }) as const,
      ),
    });

    await expect(executeJobCore(state, job())).resolves.toMatchObject({
      status: "error",
      error: "exec denied: host=gateway security=deny",
    });
    expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("fails closed when the runner is missing or triggers are disabled", async () => {
    const missing = makeState();
    await expect(executeJobCore(missing, job())).resolves.toMatchObject({
      status: "error",
      error: "cron shell precheck runner is unavailable",
    });
    expect(missing.deps.runIsolatedAgentJob).not.toHaveBeenCalled();

    const disabled = makeState({
      cronConfig: { triggers: { enabled: false } },
      runJobPrecheck: vi.fn(
        async () => ({ kind: "work", exitCode: 0 }) satisfies CronJobPrecheckResult,
      ),
    });
    await expect(executeJobCore(disabled, job())).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("cron.triggers.enabled: false"),
    });
    expect(disabled.deps.runJobPrecheck).not.toHaveBeenCalled();
    expect(disabled.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("runs the payload only after a work result and a current run check", async () => {
    const order: string[] = [];
    const state = makeState({
      runJobPrecheck: vi.fn(async () => {
        order.push("precheck");
        return { kind: "work", exitCode: 0 } satisfies CronJobPrecheckResult;
      }),
      runIsolatedAgentJob: vi.fn(async () => {
        order.push("payload");
        return { status: "ok" as const };
      }),
    });

    await executeJobCore(state, job(), undefined, {
      assertRunCurrent: async () => {
        order.push("authority");
      },
    });

    expect(order[0]).toBe("authority");
    expect(order).toContain("precheck");
    expect(order.at(-1)).toBe("payload");
  });

  it("does not start the probe after run authority is rejected", async () => {
    const state = makeState({
      runJobPrecheck: vi.fn(
        async () => ({ kind: "work", exitCode: 0 }) satisfies CronJobPrecheckResult,
      ),
    });

    await expect(
      executeJobCore(state, job(), undefined, {
        assertRunCurrent: async () => {
          throw new Error("stale run");
        },
      }),
    ).rejects.toThrow("stale run");
    expect(state.deps.runJobPrecheck).not.toHaveBeenCalled();
    expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
  });
});
