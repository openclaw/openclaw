import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-failure-notification-",
  baseTimeIso: "2026-01-01T00:00:00.000Z",
});

describe("CronService failure notification delivery", () => {
  it.each([
    {
      name: "a persistent target instead of its creation conversation",
      agentId: "ops",
      sessionKey: "agent:ops:telegram:group:42:topic:77",
      creationSessionKey: "agent:ops:discord:channel:other",
      sessionTarget: "session:agent:ops:telegram:group:42:topic:77" as const,
      wakeMode: "now" as const,
      carriesOrigin: true,
    },
    {
      name: "a targeted next-heartbeat conversation immediately",
      agentId: "ops",
      sessionKey: "agent:ops:telegram:group:42:topic:77",
      creationSessionKey: "agent:ops:telegram:group:42:topic:77",
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      carriesOrigin: true,
    },
    {
      name: "the default owner without exposing its last group",
      agentId: "main",
      sessionKey: undefined,
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      carriesOrigin: false,
    },
    {
      name: "the default owner even when the failed job uses a deferred wake mode",
      agentId: "main",
      sessionKey: undefined,
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      carriesOrigin: false,
    },
  ])("routes a rejected failure alert to $name with scheduling disabled", async (testCase) => {
    const deliveryContext: DeliveryContext = {
      channel: "telegram",
      to: "-10042",
      threadId: 77,
    };
    const enqueueSessionEvent = vi.fn();
    const store = await makeStorePath();
    const resolveOriginDeliveryContext = vi.fn(async () => deliveryContext);
    const sendCronFailureAlert = vi.fn(async (params) => {
      await params.onDeliverySettled({
        delivered: false,
        status: "not-delivered",
        error: "failure alert channel unavailable",
      });
      throw new Error("failure alert channel unavailable");
    });
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath: store.storePath,
      cronEnabled: false,
      cronConfig: { failureAlert: { enabled: true, after: 1 } },
      defaultAgentId: "main",
      log: logger,
      resolveOriginDeliveryContext,
      enqueueSystemEvent: vi.fn(),
      enqueueSessionEvent,
      sendCronFailureAlert,
      runIsolatedAgentJob: async () => ({
        status: "error",
        error: "temporary upstream error",
      }),
      runSessionEvent: async () => ({
        status: "error",
        error: "temporary upstream error",
      }),
    });
    try {
      await cron.start();
      const job = await cron.add({
        name: "Important report",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: testCase.sessionTarget,
        ...("creationSessionKey" in testCase ? { sessionKey: testCase.creationSessionKey } : {}),
        wakeMode: testCase.wakeMode,
        payload: { kind: "agentTurn", message: "run report" },
      });

      await cron.run(job.id, "force");
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      await expect(sendCronFailureAlert.mock.results[0]?.value).rejects.toThrow(
        "failure alert channel unavailable",
      );
      expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('Automation "Important report" failed 1 times'),
        {
          agentId: testCase.agentId,
          sessionKey: testCase.sessionKey,
          contextKey: `cron:${job.id}:failure-alert`,
          ...(testCase.sessionKey ? {} : { createIfMissing: true }),
          ...(testCase.carriesOrigin ? { deliveryContext } : {}),
        },
      );
      if (testCase.carriesOrigin) {
        expect(resolveOriginDeliveryContext).toHaveBeenCalledOnce();
      } else {
        expect(resolveOriginDeliveryContext).not.toHaveBeenCalled();
      }
    } finally {
      cron.stop();
    }
  });
});
