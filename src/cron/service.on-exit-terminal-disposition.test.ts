import { expect, it } from "vitest";
import {
  createTelegramDelivery,
  setupFailureAlertSuite,
} from "./service.failure-alert.test-helpers.js";

const { withFailureAlertCron } = setupFailureAlertSuite();
const schedule = { kind: "on-exit", command: "echo done" } as const;
const permanentError = "invalid job configuration";
const routed = createTelegramDelivery();

it.each<
  [
    name: string,
    error: string,
    delivery: ReturnType<typeof createTelegramDelivery>,
    notices: number,
    alerts: number,
    priorFailures?: number,
  ]
>([
  ["permanent failure with route", permanentError, routed, 0, 1],
  ["transient failure with route", "rate limit exceeded", routed, 0, 1],
  ["same incident during cooldown", permanentError, routed, 0, 1, 2],
  ["no route", permanentError, { mode: "none" }, 1, 0],
  ["best-effort route", permanentError, { ...routed, bestEffort: true }, 1, 0],
])(
  "records and notifies a watcher terminal %s",
  async (_name, error, delivery, notices, alerts, priorFailures = 0) => {
    await withFailureAlertCron({}, async (f) => {
      f.runIsolatedAgentJob.mockResolvedValue({ status: "error", error });
      const job = await f.addJob("completed watcher", { schedule, delivery });
      for (let attempt = 0; attempt < priorFailures; attempt += 1) {
        await f.cron.run(job.id, "force");
      }
      await expect(
        f.cron.runOnExit(job.id, {
          schedule,
          signal: new AbortController().signal,
          commitGuard: () => {},
          onReserved: () => {},
        }),
      ).resolves.toMatchObject({ ok: true, ran: true });
      const stored = await f.cron.readJob(job.id);
      expect(stored?.state.nextRunAtMs).toBeUndefined();
      expect(stored).toMatchObject({
        enabled: false,
        state: {
          autoDisabled: { reason: "consecutive-failures", consecutiveErrors: priorFailures + 1 },
        },
      });
      expect(f.runCronFailureRepair).not.toHaveBeenCalled();
      expect(f.sendCronFailureAlert).toHaveBeenCalledTimes(alerts);
      expect(f.enqueueSessionEvent).toHaveBeenCalledTimes(notices);
      if (notices) {
        expect(f.enqueueSessionEvent).toHaveBeenCalledWith(
          expect.stringContaining("auto-disabled"),
          expect.objectContaining({ contextKey: `cron:${job.id}:auto-disabled` }),
        );
      }
    });
  },
);

it.each([true, false])(
  "preserves an operator force-run of an on-exit job with enabled=%s",
  async (enabled) => {
    await withFailureAlertCron({}, async (f) => {
      f.runIsolatedAgentJob.mockResolvedValue({
        status: "error",
        error: "invalid job configuration",
      });
      const job = await f.addJob("manual watcher run", {
        enabled,
        schedule,
        delivery: createTelegramDelivery(),
      });
      await f.cron.run(job.id, "force");
      const stored = await f.cron.readJob(job.id);
      expect(stored?.enabled).toBe(enabled);
      expect(stored?.state.autoDisabled).toBeUndefined();
      expect(f.enqueueSessionEvent).not.toHaveBeenCalled();
      expect(f.sendCronFailureAlert).not.toHaveBeenCalled();
      expect(f.runCronFailureRepair).not.toHaveBeenCalled();
    });
  },
);
