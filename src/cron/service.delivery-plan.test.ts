import { expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  withCronServiceForTest,
} from "./service.test-harness.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-delivery-" });

it.each([
  { delivered: true, expected: "delivered", wakeMode: "now" },
  { delivered: undefined, expected: "unknown", wakeMode: "next-heartbeat" },
] as const)(
  "records $expected delivery without a duplicate relay",
  async ({ delivered, expected, wakeMode }) => {
    await withCronServiceForTest(
      {
        makeStorePath,
        scheduler: createTestGatewayScheduler(),
        logger: createNoopLogger(),
        cronEnabled: false,
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "ok" as const,
          summary: "done",
          delivered,
        })),
      },
      async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
        const job = await cron.add({
          name: "announce-delivered",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
          sessionTarget: "isolated",
          wakeMode,
          payload: { kind: "agentTurn", message: "hello" },
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        });
        expect(await cron.run(job.id, "force")).toEqual({ ok: true, ran: true });
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();
        expect(cron.getJob(job.id)?.state.lastDeliveryStatus).toBe(expected);
      },
    );
  },
);
