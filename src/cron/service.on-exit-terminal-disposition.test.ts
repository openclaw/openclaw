import { expect, it } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createTelegramDelivery,
  setupFailureAlertSuite,
} from "./service.failure-alert.test-helpers.js";

const { withFailureAlertCron } = setupFailureAlertSuite();
const schedule = { kind: "on-exit", command: "echo done" } as const;

it.each([
  {
    name: "permanent failure with route",
    error: "invalid job configuration",
    delivery: createTelegramDelivery(),
    notices: 0,
    alerts: 1,
  },
  {
    name: "transient failure with route",
    error: "rate limit exceeded",
    delivery: createTelegramDelivery(),
    notices: 0,
    alerts: 1,
  },
  {
    name: "same incident during cooldown",
    error: "invalid job configuration",
    delivery: createTelegramDelivery(),
    priorFailures: 2,
    notices: 0,
    alerts: 1,
  },
  {
    name: "no route",
    error: "invalid job configuration",
    delivery: { mode: "none" as const },
    notices: 1,
    alerts: 0,
  },
  {
    name: "best-effort route",
    error: "invalid job configuration",
    delivery: { ...createTelegramDelivery(), bestEffort: true },
    notices: 1,
    alerts: 0,
  },
])(
  "records and notifies a watcher terminal $name",
  async ({ error, delivery, notices, alerts, priorFailures = 0 }) => {
    await withFailureAlertCron(
      { scheduler: createTestGatewayScheduler() },
      async ({
        cron,
        addJob,
        runIsolatedAgentJob,
        runCronFailureRepair,
        sendCronFailureAlert,
        enqueueSystemEvent,
      }) => {
        runIsolatedAgentJob.mockResolvedValue({ status: "error", error });
        const job = await addJob("completed watcher", { schedule, delivery });
        for (let attempt = 0; attempt < priorFailures; attempt += 1) {
          await cron.run(job.id, "force");
        }
        await expect(
          cron.runOnExit(job.id, {
            schedule,
            signal: new AbortController().signal,
            commitGuard: () => {},
            onReserved: () => {},
          }),
        ).resolves.toMatchObject({ ok: true, ran: true });
        // Read through the persisted service boundary, including the worker request serialization.
        const stored = await cron.readJob(job.id);
        expect(stored?.state.nextRunAtMs).toBeUndefined();
        expect(stored).toMatchObject({
          enabled: false,
          state: {
            autoDisabled: { reason: "consecutive-failures", consecutiveErrors: priorFailures + 1 },
          },
        });
        expect(runCronFailureRepair).not.toHaveBeenCalled();
        expect(sendCronFailureAlert).toHaveBeenCalledTimes(alerts);
        expect(enqueueSystemEvent).toHaveBeenCalledTimes(notices);
        if (notices) {
          expect(enqueueSystemEvent).toHaveBeenCalledWith(
            expect.stringContaining("auto-disabled"),
            expect.objectContaining({ contextKey: `cron:${job.id}:auto-disabled` }),
          );
        }
      },
    );
  },
);

it.each([true, false])(
  "preserves an operator force-run of an on-exit job with enabled=%s",
  async (enabled) => {
    await withFailureAlertCron(
      { scheduler: createTestGatewayScheduler() },
      async ({
        cron,
        addJob,
        runIsolatedAgentJob,
        runCronFailureRepair,
        sendCronFailureAlert,
        enqueueSystemEvent,
      }) => {
        runIsolatedAgentJob.mockResolvedValue({
          status: "error",
          error: "invalid job configuration",
        });
        const job = await addJob("manual watcher run", {
          enabled,
          schedule,
          delivery: createTelegramDelivery(),
        });
        await cron.run(job.id, "force");
        const stored = await cron.readJob(job.id);
        expect(stored?.enabled).toBe(enabled);
        expect(stored?.state.autoDisabled).toBeUndefined();
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(sendCronFailureAlert).not.toHaveBeenCalled();
        expect(runCronFailureRepair).not.toHaveBeenCalled();
      },
    );
  },
);
