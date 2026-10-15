import { expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  withCronServiceForTest,
} from "./service.test-harness.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-delivery-" });

it("records delivered delivery without a duplicate relay", async () => {
  await withCronServiceForTest(
    {
      makeStorePath,
      scheduler: createTestGatewayScheduler(),
      logger: createNoopLogger(),
      cronEnabled: false,
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        delivered: true,
      })),
    },
    async ({ cron, enqueueSystemEvent, enqueueSessionEvent }) => {
      const job = await cron.add({
        name: "announce-delivered",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "hello" },
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      });
      expect(await cron.run(job.id, "force")).toEqual({ ok: true, ran: true });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(enqueueSessionEvent).not.toHaveBeenCalled();
      expect(cron.getJob(job.id)?.state.lastDeliveryStatus).toBe("delivered");
    },
  );
});

it("rejects an authored delivery object without a mode", async () => {
  await withCronServiceForTest(
    {
      makeStorePath,
      scheduler: createTestGatewayScheduler(),
      logger: createNoopLogger(),
      cronEnabled: false,
    },
    async ({ cron, enqueueSystemEvent, enqueueSessionEvent }) => {
      const delivery = { mode: "announce" as const, channel: "telegram", to: "123" };
      Reflect.deleteProperty(delivery, "mode");
      await expect(
        cron.add({
          name: "partial-delivery",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "hello" },
          delivery,
        }),
      ).rejects.toThrow("delivery requires an explicit mode");
      expect(await cron.list()).toEqual([]);
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(enqueueSessionEvent).not.toHaveBeenCalled();
    },
  );
});
