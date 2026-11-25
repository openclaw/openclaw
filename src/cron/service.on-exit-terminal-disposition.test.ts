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
    alerts: number,
    priorFailures?: number,
  ]
>([
  ["permanent failure with route", permanentError, routed, 1],
  ["transient failure with route", "rate limit exceeded", routed, 1],
  ["same incident during cooldown", permanentError, routed, 2, 2],
  ["no route", permanentError, { mode: "none" }, 0],
  ["best-effort route", permanentError, { ...routed, bestEffort: true }, 0],
])("ends a watcher on a terminal %s", async (_name, error, delivery, alerts, priorFailures = 0) => {
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
      state: { consecutiveErrors: priorFailures + 1 },
    });
    expect(stored?.state.autoDisabled).toBeUndefined();
    expect(f.runCronFailureRepair).not.toHaveBeenCalled();
    expect(f.sendCronFailureAlert).toHaveBeenCalledTimes(alerts);
    expect(f.enqueueSessionEvent).not.toHaveBeenCalled();
  });
});

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
      // An ordinary first-failure alert, not a terminal auto-disable notice.
      expect(f.sendCronFailureAlert).toHaveBeenCalledOnce();
      expect(f.sendCronFailureAlert.mock.calls[0]?.[0]?.payload.text).not.toContain(
        "auto-disabled",
      );
      expect(f.runCronFailureRepair).not.toHaveBeenCalled();
    });
  },
);
