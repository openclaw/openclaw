import { describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { HeartbeatRunOptions } from "../../infra/heartbeat-runner-execution.js";
import {
  resolveHeartbeatPreflight,
  resolveHeartbeatRunPrompt,
} from "../../infra/heartbeat-runner-prompt.js";
import { startHeartbeatRunner } from "../../infra/heartbeat-runner-scheduler.js";
import { requestHeartbeatAndWait } from "../../infra/heartbeat-wake.js";
import {
  drainSystemEvents,
  enqueueSystemEvent as queueSystemEvent,
  peekSystemEventEntries,
} from "../../infra/system-events.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { executeJobCore } from "./timer-execution.js";

describe("cron script immediate wake", () => {
  it.each([
    ["main", "now", "The deployment queue needs attention."],
    ["isolated", "now", undefined],
    ["main", "next-heartbeat", "Keep this reminder for the next heartbeat."],
  ] as const)(
    "honors %s / %s when recurring heartbeat cadence is disabled",
    async (sessionTarget, wake, notify) => {
      const expectedText = notify ?? "script job script job completed";
      const contextKey = `cron:script-job:${notify ? "script" : "script-wake"}`;
      vi.useFakeTimers();
      const now = Date.parse("2026-08-24T12:00:00.000Z");
      vi.setSystemTime(now);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { heartbeat: { every: "0m" } },
          entries: { main: {}, finn: {} },
        },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "finn" });
      const prompts: string[] = [];
      const pendingWakes: Array<ReturnType<typeof requestHeartbeatAndWait>> = [];
      const runOnce = vi.fn(async (options: HeartbeatRunOptions) => {
        const { heartbeat, source, reason } = options;
        const context = { sessionKey: options.sessionKey, heartbeat, source, reason };
        const prompt = resolveHeartbeatRunPrompt({
          cfg,
          preflight: await resolveHeartbeatPreflight({ ...context, cfg, agentId: "finn" }),
          canRelayToUser: true,
          scheduledTasks: [],
          useHeartbeatResponseTool: false,
        });
        expect(prompt.hasCronEvents).toBe(true);
        prompts.push(prompt.prompt);
        return { status: "ran" as const, durationMs: 1 };
      });
      const runner = startHeartbeatRunner({ cfg, readCurrentConfig: () => cfg, runOnce });

      try {
        const state = createCronRegressionState({
          storePath: "/tmp/cron-script-wake-state.sqlite",
          cronConfig: { triggers: { enabled: true } },
          nowMs: () => now,
          enqueueSystemEvent: (text, options) =>
            queueSystemEvent(text, {
              sessionKey,
              contextKey: options?.contextKey,
              deliveryContext: options?.deliveryContext,
            }),
          requestHeartbeat: (wakeRequest) => {
            pendingWakes.push(
              requestHeartbeatAndWait({ ...wakeRequest, sessionKey, coalesceMs: 0 }),
            );
          },
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          runScriptJob: vi.fn(async () => ({ status: "ok" as const, notify, wake })),
        });
        const job = makeCronJob({
          id: "script-job",
          name: "script job",
          agentId: "finn",
          sessionTarget,
          wakeMode: "now",
          payload: { kind: "script", script: "return { wake: 'now' }" },
        });

        await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });
        expect(peekSystemEventEntries(sessionKey)).toEqual([
          expect.objectContaining({ text: expectedText, contextKey }),
        ]);

        await vi.advanceTimersByTimeAsync(1);
        await Promise.all(pendingWakes);

        if (wake === "next-heartbeat") {
          expect(runOnce).not.toHaveBeenCalled();
          expect(peekSystemEventEntries(sessionKey)).toEqual([
            expect.objectContaining({ text: expectedText, contextKey }),
          ]);
          return;
        }

        expect(runOnce).toHaveBeenCalledOnce();
        expect(runOnce).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "finn",
            sessionKey,
            source: "notifications-event",
            intent: "immediate",
            reason: "wake",
          }),
        );
        expect(prompts[0]).toContain(expectedText);
        expect(prompts[0]).toContain("Please relay this reminder to the user");
      } finally {
        try {
          // Stopping the runner retains unfinished notifications for its successor.
          await vi.advanceTimersByTimeAsync(1);
          await Promise.all(pendingWakes);
        } finally {
          runner.stop();
          drainSystemEvents(sessionKey);
          vi.useRealTimers();
        }
      }
    },
  );
});
