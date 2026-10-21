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

function commandFixture(
  id: string,
  argv = ["unused"],
  runner: typeof runCronCommandJob = runCronCommandJob,
) {
  const job = createIsolatedRegressionJob({
    id,
    name: id,
    scheduledAt: Date.now(),
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "command", argv, timeoutSeconds: 1 },
  });
  const sendCronWebhook = vi.fn();
  let command: ReturnType<typeof runner> | undefined;
  const state = createCronRegressionState({
    storePath: path.join(tempDirs.make("cron-command-"), "jobs.json"),
    runIsolatedAgentJob: vi.fn(),
    runCommandJob: (params) => (command = runner(params)),
    sendCronWebhook,
  });
  return { job, state, sendCronWebhook, settle: () => command };
}

describe("scheduled command timeouts", () => {
  it.each(["deadline", "operator cancellation"] as const)(
    "settles a real command after %s without late delivery",
    async (interruption) => {
      const { job, state, sendCronWebhook, settle } = commandFixture("command-timeout", [
        process.execPath,
        "-e",
        "console.log('synthetic progress pid=' + process.pid); console.error('synthetic stderr'); setInterval(() => {}, 1000)",
      ]);
      job.delivery = { mode: "webhook", to: "https://example.com/automation" };
      const activeJobMarker = markCronJobActive(job.id);
      try {
        const run = executeJobCoreWithTimeout(state, job, { runId: job.id, activeJobMarker });
        if (interruption === "operator cancellation") {
          requestActiveCronJobCancellation(job.id, "Cancelled by operator.");
        }
        const result = await run;
        expect(sendCronWebhook).not.toHaveBeenCalled();
        if (interruption === "operator cancellation") {
          expect(result).toMatchObject({
            status: "error",
            error: "Cancelled by operator.",
          });
          expect(result.failureNotificationDetail).toBeUndefined();
          return;
        }
        expect(result).toMatchObject({
          status: "error",
          error: "command timed out",
          errorClassification: { kind: "reason", reason: "timeout" },
          failureNotificationDetail: { kind: "command-timeout", mode: "wall-clock" },
          delivered: false,
        });
        expect(result.diagnostics?.entries).toContainEqual(
          expect.objectContaining({ source: "exec", severity: "error" }),
        );
        expect(result.summary).toContain("synthetic progress");
        expect(result.summary).toContain("synthetic stderr");
        const pid = Number(result.summary?.match(/pid=(\d+)/)?.[1]);
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(isPidAlive(pid)).toBe(false);
      } finally {
        await Promise.resolve(settle()).finally(() => clearCronJobActive(job.id, activeJobMarker));
      }
    },
  );

  it("bounds settlement while keeping an abort-ignoring command drain-visible", async () => {
    vi.useFakeTimers();
    const command = createDeferred<Awaited<ReturnType<typeof runCronCommandJob>>>();
    const { job, state } = commandFixture("stuck-command", ["unused"], () => command.promise);
    job.delivery = { mode: "none" };
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
