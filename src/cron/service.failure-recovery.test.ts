import { describe, expect, it, vi } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { setupFailureAlertSuite } from "./service.failure-alert.test-helpers.js";
import { createNoopLogger } from "./service.test-harness.js";
import { maybeEmitFailureRecovery, resolveFailureAlert } from "./service/failure-alerts.js";
import { createCronServiceState, type DeferredCronNotifications } from "./service/state.js";

const { withFailureAlertCron } = setupFailureAlertSuite();

describe("automation recovery notification policy", () => {
  it("accepts an explicit recovery notification preference", () => {
    expect(
      OpenClawSchema.safeParse({ cron: { failureAlert: { notifyOnRecovery: false } } }).success,
    ).toBe(true);
  });

  it.each([undefined, true, false])(
    "preserves failures while notifyOnRecovery=%s",
    async (notifyOnRecovery) => {
      await withFailureAlertCron(
        {
          scheduler: createTestGatewayScheduler(),
          failureAlert: { after: 1, cooldownMs: 3_600_000, notifyOnRecovery },
        },
        async ({ cron, addJob, runIsolatedAgentJob, sendCronFailureAlert }) => {
          const job = await addJob("Health probe", {
            delivery: { mode: "none" },
            failureAlert: { channel: "telegram", to: "19098680" },
          });
          await cron.run(job.id, "force");
          expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
          runIsolatedAgentJob.mockResolvedValue({ status: "ok" });
          await cron.run(job.id, "force");
          const afterRecovery = notifyOnRecovery === false ? 1 : 2;
          expect(sendCronFailureAlert).toHaveBeenCalledTimes(afterRecovery);
          expect(cron.getJob(job.id)?.state.failureAlertIncident).toBeUndefined();
          expect(cron.getJob(job.id)?.state.lastFailureAlertAtMs).toBeUndefined();
          await cron.run(job.id, "force");
          expect(sendCronFailureAlert).toHaveBeenCalledTimes(afterRecovery);
          // A quiet recovery must reset deduplication/cooldown before the next real failure.
          runIsolatedAgentJob.mockResolvedValue({
            status: "error",
            error: "temporary upstream error",
          });
          await cron.run(job.id, "force");
          expect(sendCronFailureAlert).toHaveBeenCalledTimes(afterRecovery + 1);
        },
      );
    },
  );

  it("quietly closes a trigger-only incident without enqueueing a recovery", () => {
    const job = makeCronJob({
      failureAlert: { channel: "telegram", to: "19098680" },
      state: {
        failureAlertIncident: { scope: "trigger", signature: "reported" },
        lastFailureAlertAtMs: 1,
      },
    });
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath: "unused",
      cronEnabled: true,
      cronConfig: { failureAlert: { notifyOnRecovery: false } },
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    });
    const deferredNotifications: DeferredCronNotifications = [];
    maybeEmitFailureRecovery({
      job,
      alertConfig: resolveFailureAlert(state, job),
      triggerOnly: true,
      deferredNotifications,
    });
    expect(job.state.failureAlertIncident).toBeUndefined();
    expect(job.state.lastFailureAlertAtMs).toBeUndefined();
    expect(deferredNotifications).toHaveLength(0);
  });
});
