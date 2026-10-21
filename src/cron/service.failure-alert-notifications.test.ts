import { expect, it, vi } from "vitest";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HeartbeatRunOptions } from "../infra/heartbeat-runner-execution.js";
import {
  resolveHeartbeatPreflight,
  resolveHeartbeatRunPrompt,
} from "../infra/heartbeat-runner-prompt.js";
import { startHeartbeatRunner } from "../infra/heartbeat-runner-scheduler.js";
import { requestHeartbeatAndWait } from "../infra/heartbeat-wake.js";
import {
  drainSystemEvents,
  enqueueSystemEvent,
  peekSystemEventEntries,
} from "../infra/system-events.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-failure-notification-",
  baseTimeIso: "2026-01-01T00:00:00.000Z",
});
const target = "agent:ops:telegram:group:42:topic:77";
const otherConversation = "agent:ops:discord:channel:other";
const deliveryContext: DeliveryContext = { channel: "telegram", to: "-10042", threadId: 77 };

it.each([
  ["persistent target", `session:${target}`, otherConversation, "now", true],
  ["targeted next-heartbeat", "isolated", target, "next-heartbeat", true],
  ["default owner", "isolated", undefined, "now", false],
] as const)(
  "routes a rejected failure alert to %s with cadence disabled",
  async (_name, sessionTarget, creationSessionKey, wakeMode, carriesOrigin) => {
    const agentId = carriesOrigin ? "ops" : "main";
    const expectedSessionKey = carriesOrigin ? target : "agent:main:main";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "0m" } },
        entries: { main: {}, ops: {} },
      },
    };
    const observed: Array<{ prompt: string; deliveryContext?: DeliveryContext }> = [];
    const pendingWakes: Array<ReturnType<typeof requestHeartbeatAndWait>> = [];
    const resolveSession = (options: { sessionKey?: string; agentId?: string } = {}) =>
      options.sessionKey ?? resolveAgentMainSessionKey({ cfg, agentId: options.agentId ?? "main" });
    const runOnce = vi.fn(async (options: HeartbeatRunOptions) => {
      const { sessionKey, heartbeat, source, reason } = options;
      const pendingEventEntries = peekSystemEventEntries(sessionKey ?? "");
      const wakeContext = { cfg, agentId, sessionKey, heartbeat, source, reason };
      const preflight = await resolveHeartbeatPreflight(wakeContext);
      observed.push({
        prompt: resolveHeartbeatRunPrompt({
          cfg,
          preflight,
          canRelayToUser: true,
          scheduledTasks: [],
          useHeartbeatResponseTool: false,
        }).prompt,
        deliveryContext: pendingEventEntries[0]?.deliveryContext,
      });
      return { status: "ran" as const, durationMs: 1 };
    });
    const runner = startHeartbeatRunner({ cfg, readCurrentConfig: () => cfg, runOnce });
    const resolveOriginDeliveryContext = vi.fn(async () => deliveryContext);
    const sendCronFailureAlert = vi.fn(async (params) => {
      await params.onDeliverySettled({
        delivered: false,
        status: "not-delivered",
        error: "failure alert channel unavailable",
      });
      throw new Error("failure alert channel unavailable");
    });
    const failRun = async () => ({
      status: "error" as const,
      error: "temporary upstream error",
    });
    const cron = new CronService({
      ...cronTestDeps({ storePath: (await makeStorePath()).storePath }),
      cronConfig: { failureAlert: { enabled: true, after: 1 } },
      defaultAgentId: "main",
      log: logger,
      resolveOriginDeliveryContext,
      enqueueSystemEvent: (text, options) =>
        enqueueSystemEvent(text, {
          sessionKey: resolveSession(options),
          contextKey: options?.contextKey,
          deliveryContext: options?.deliveryContext,
        }),
      requestHeartbeat: (wake) => {
        pendingWakes.push(
          requestHeartbeatAndWait({
            ...wake,
            sessionKey: resolveSession(wake),
            coalesceMs: 0,
          }),
        );
      },
      sendCronFailureAlert,
      runIsolatedAgentJob: failRun,
      runSessionEvent: failRun,
    });
    try {
      await cron.start();
      const job = await cron.add({
        ...cronTestInput(),
        name: "Important report",
        sessionTarget,
        sessionKey: creationSessionKey,
        wakeMode,
      });

      await cron.run(job.id, "force");
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      await expect(sendCronFailureAlert.mock.results[0]?.value).rejects.toThrow(
        "failure alert channel unavailable",
      );
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all(pendingWakes);

      expect(peekSystemEventEntries(expectedSessionKey)).toHaveLength(1);
      expect(runOnce).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentId,
          sessionKey: expectedSessionKey,
          source: "notifications-event",
          intent: "immediate",
          reason: "wake",
        }),
      );
      expect(observed[0]?.prompt).toContain('Automation "Important report" failed 1 times');
      expect(observed[0]?.prompt).toContain("Please relay this reminder to the user");
      expect(observed[0]?.deliveryContext).toEqual(carriesOrigin ? deliveryContext : undefined);
      expect(resolveOriginDeliveryContext).toHaveBeenCalledTimes(carriesOrigin ? 1 : 0);
    } finally {
      cron.stop();
      try {
        // Stopping the runner retains unfinished notifications for its successor.
        await vi.advanceTimersByTimeAsync(1);
        await Promise.all(pendingWakes);
      } finally {
        runner.stop();
        drainSystemEvents(expectedSessionKey);
      }
    }
  },
);
