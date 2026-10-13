import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createIsolatedRegressionJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import {
  clearCronJobActive,
  markCronJobActive,
  requestActiveCronJobCancellation,
} from "../active-jobs.js";
import { runCronCommandJob } from "../command-runner.js";
import {
  getSuspensionVisibleCronTaskRunCount,
  waitForActiveCronTaskRuns,
} from "./active-run-cancellation.js";
import { executeJobCoreWithTimeout } from "./timer-job-runner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("scheduled command timeouts", () => {
  it.each(["deadline", "operator cancellation"] as const)(
    "settles a real command after %s without late delivery",
    async (interruption) => {
      const job = createIsolatedRegressionJob({
        id: "command-timeout",
        name: "command timeout",
        scheduledAt: Date.now(),
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "command",
          argv: [
            process.execPath,
            "-e",
            "console.log('synthetic progress pid=' + process.pid); console.error('synthetic stderr'); setInterval(() => {}, 1000)",
          ],
          timeoutSeconds: 1,
        },
      });
      job.delivery = { mode: "webhook", to: "https://example.com/automation" };
      const sendCronWebhook = vi.fn();
      let command: ReturnType<typeof runCronCommandJob> | undefined;
      const state = createCronRegressionState({
        storePath: path.join(tempDirs.make("cron-command-timeout-"), "jobs.json"),
        runIsolatedAgentJob: vi.fn(),
        runCommandJob: (params) => {
          command = runCronCommandJob(params);
          return command;
        },
        sendCronWebhook,
      });

      const activeJobMarker = markCronJobActive(job.id);
      try {
        const run = executeJobCoreWithTimeout(state, job, { runId: job.id, activeJobMarker });
        if (interruption === "operator cancellation") {
          requestActiveCronJobCancellation(job.id, "Cancelled by operator.");
        }
        const result = await run;
        if (interruption === "operator cancellation") {
          expect(result).toMatchObject({ status: "error", error: "Cancelled by operator." });
          expect(result.failureNotificationDetail).toBeUndefined();
          expect(sendCronWebhook).not.toHaveBeenCalled();
          return;
        }
        expect(result).toMatchObject({
          status: "error",
          error: "command timed out",
          errorClassification: { kind: "reason", reason: "timeout" },
          failureNotificationDetail: { kind: "command-timeout", mode: "wall-clock" },
          delivered: false,
        });
        expect(result.summary).toContain("synthetic progress");
        expect(result.summary).toContain("synthetic stderr");
        expect(result.diagnostics?.entries).toContainEqual(
          expect.objectContaining({ source: "exec", severity: "error" }),
        );
        const pid = Number(result.summary?.match(/pid=(\d+)/)?.[1]);
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(isPidAlive(pid)).toBe(false);
        expect(sendCronWebhook).not.toHaveBeenCalled();
      } finally {
        try {
          await command;
        } finally {
          clearCronJobActive(job.id, activeJobMarker);
        }
      }
    },
  );

  it("bounds settlement while keeping an abort-ignoring command drain-visible", async () => {
    vi.useFakeTimers();
    const command = createDeferred<Awaited<ReturnType<typeof runCronCommandJob>>>();
    const job = createIsolatedRegressionJob({
      id: "stuck-command",
      name: "stuck command",
      scheduledAt: Date.now(),
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "command", argv: ["unused"], timeoutSeconds: 1 },
    });
    job.delivery = { mode: "none" };
    const state = createCronRegressionState({
      storePath: path.join(tempDirs.make("cron-command-settlement-"), "jobs.json"),
      runIsolatedAgentJob: vi.fn(),
      runCommandJob: () => command.promise,
    });
    let settled = false;
    const run = executeJobCoreWithTimeout(state, job).then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await run).toMatchObject({ status: "error", error: "cron: job execution timed out" });
      expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);
      command.resolve({ status: "ok", summary: "late completion" });
      await expect(waitForActiveCronTaskRuns(1_000)).resolves.toEqual({ drained: true, active: 0 });
      expect(getSuspensionVisibleCronTaskRunCount()).toBe(0);
    } finally {
      command.resolve({ status: "ok" });
      await run;
      vi.useRealTimers();
    }
  });
});
