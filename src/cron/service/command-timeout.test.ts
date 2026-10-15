import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createIsolatedRegressionJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import {
  clearCronJobActive,
  markCronJobActive,
  requestActiveCronJobCancellation,
} from "../active-jobs.js";
import { runCronCommandJob } from "../command-runner.js";
import * as proactiveReceipts from "../proactive-job-receipt.js";
import {
  getSuspensionVisibleCronTaskRunCount,
  waitForActiveCronTaskRuns,
} from "./active-run-cancellation.js";
import type { CronServiceDeps } from "./state.js";
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
            "const fs = require('node:fs'); fs.writeSync(1, 'synthetic progress pid=' + process.pid + '\\n'); fs.writeSync(2, 'synthetic stderr\\n'); setInterval(() => {}, 1000)",
          ],
          timeoutSeconds: 1,
        },
      });
      job.delivery = { mode: "webhook", to: "https://example.com/automation" };
      const sendCronWebhook = vi.fn();
      const commandStarted = createDeferred();
      let command: ReturnType<typeof runCronCommandJob> | undefined;
      const state = createCronRegressionState({
        storePath: path.join(tempDirs.make("cron-command-timeout-"), "jobs.json"),
        runIsolatedAgentJob: vi.fn(),
        runCommandJob: (params) => {
          command = runCronCommandJob(params);
          commandStarted.resolve();
          return command;
        },
        sendCronWebhook,
      });

      const activeJobMarker = markCronJobActive(job.id);
      try {
        const run = executeJobCoreWithTimeout(state, job, { runId: job.id, activeJobMarker });
        if (interruption === "operator cancellation") {
          await awaitGateBeforeSettlement(
            commandStarted.promise,
            run,
            "Scheduled command settled before entering the command runner",
          );
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
        expect(result.summary, JSON.stringify(result)).toContain("synthetic progress");
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
          await expect(waitForActiveCronTaskRuns(1_000)).resolves.toEqual({
            drained: true,
            active: 0,
          });
        } finally {
          clearCronJobActive(job.id, activeJobMarker);
        }
      }
    },
  );

  it.each(["timeout", "revoked"] as const)(
    "preserves command timeout and live authority through delayed preflight: %s",
    async (completion) => {
      vi.useFakeTimers();
      const preflightStarted = createDeferred();
      const releasePreflight = createDeferred();
      const originalRead = proactiveReceipts.readDefaultProactiveJobReceiptsAsync;
      const readReceipt = vi
        .spyOn(proactiveReceipts, "readDefaultProactiveJobReceiptsAsync")
        .mockImplementationOnce(async (...args) => {
          preflightStarted.resolve();
          await releasePreflight.promise;
          return await originalRead(...args);
        });
      const command = createDeferred<Awaited<ReturnType<typeof runCronCommandJob>>>();
      const commandStarted = createDeferred();
      let commandSignal: AbortSignal | undefined;
      const runCommandJob = vi.fn<NonNullable<CronServiceDeps["runCommandJob"]>>((params) => {
        commandSignal = params.abortSignal;
        commandStarted.resolve();
        return command.promise;
      });
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
        runCommandJob,
      });
      const activeJobMarker = markCronJobActive(job.id);
      let settled = false;
      const run = executeJobCoreWithTimeout(state, job, { activeJobMarker }).then((result) => {
        settled = true;
        return result;
      });
      try {
        await awaitGateBeforeSettlement(
          preflightStarted.promise,
          run,
          "Scheduled command settled before its migration preflight",
        );
        await vi.advanceTimersByTimeAsync(2_000);
        expect(settled).toBe(false);
        expect(runCommandJob).not.toHaveBeenCalled();
        if (completion === "revoked") {
          clearCronJobActive(job.id, activeJobMarker);
        }
        releasePreflight.resolve();
        if (completion === "revoked") {
          await expect(run).rejects.toThrow("Gateway restarting.");
          expect(runCommandJob).not.toHaveBeenCalled();
          await expect(waitForActiveCronTaskRuns(1_000)).resolves.toEqual({
            drained: true,
            active: 0,
          });
          return;
        }
        await awaitGateBeforeSettlement(
          commandStarted.promise,
          run,
          "Scheduled command settled before entering the abort-ignoring runner",
        );
        await vi.advanceTimersByTimeAsync(999);
        expect(commandSignal?.aborted).toBe(false);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(commandSignal?.aborted).toBe(true);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await run).toMatchObject({
          status: "error",
          error: "cron: job execution timed out",
        });
        expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);
        command.resolve({ status: "ok", summary: "late completion" });
        await expect(waitForActiveCronTaskRuns(1_000)).resolves.toEqual({
          drained: true,
          active: 0,
        });
        expect(getSuspensionVisibleCronTaskRunCount()).toBe(0);
      } finally {
        releasePreflight.resolve();
        command.resolve({ status: "ok" });
        try {
          await run.catch(() => undefined);
        } finally {
          readReceipt.mockRestore();
          clearCronJobActive(job.id, activeJobMarker);
          vi.useRealTimers();
        }
      }
    },
  );
});
