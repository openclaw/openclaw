import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
} from "../logging/diagnostic-run-activity.js";
import { createSessionControllerWatchdog } from "../sessions/session-controller.watchdog.js";
import { runBeforeAgentReplyForTurn } from "./before-agent-reply.js";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import type { PluginHookAgentContext } from "./hook-types.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";

describe("runBeforeAgentReplyForTurn semantic progress", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetGlobalHookRunner();
  });

  function installHook(
    handler: (
      event: { cleanedBody: string },
      ctx: PluginHookAgentContext,
    ) => Promise<{ handled: true; reason: string } | undefined>,
  ) {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_agent_reply",
          handler,
          eligibleTriggers: ["cron", "heartbeat"],
        },
      ]),
    );
  }

  it("keeps a long-running hook alive past 360s via watchdog binding and rejects post-settlement renewals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    let stoppedReason: string | undefined;
    const watchdog = createSessionControllerWatchdog({
      startedAtMs: 0,
      isCurrent: () => stoppedReason === undefined,
      readPhase: () => (stoppedReason === undefined ? "active" : "terminal"),
      requestStop: (reason) => {
        stoppedReason = reason;
        return "requested";
      },
      expireCleanup: () => "settled",
    });

    const assertCurrent = () => {
      if (stoppedReason !== undefined) {
        throw new Error(`stopped:${stoppedReason}`);
      }
    };
    const onProgress = vi.fn();

    let retainedReportProgress: ((detail?: string) => void) | undefined;
    installHook(async (_event, ctx) => {
      retainedReportProgress = ctx.reportProgress;
      // Simulate an 18-workspace fleet sweep (~396s total, 22s per workspace)
      for (let i = 0; i < 18; i++) {
        await vi.advanceTimersByTimeAsync(22_000);
        const decision = watchdog.decide(Date.now());
        if (decision.action === "stop") {
          stoppedReason = decision.reason;
          return undefined;
        }
        ctx.reportProgress?.("dreaming:workspace_done");
      }
      return { handled: true, reason: "memory-core: short-term dreaming processed" };
    });

    try {
      const result = await runBeforeAgentReplyForTurn({
        runId: "run-dreaming-fleet",
        trigger: "cron",
        assertCurrent,
        onProgress,
        watchdog,
        event: { cleanedBody: "__openclaw_memory_core_short_term_promotion_dream__" },
        context: {
          runId: "run-dreaming-fleet",
          sessionId: "sess-1",
          sessionKey: "agent:main:cron:dreaming",
          trigger: "cron",
        },
      });

      expect(stoppedReason).toBeUndefined();
      expect(result).toEqual({
        handled: true,
        reason: "memory-core: short-term dreaming processed",
      });
      expect(onProgress).toHaveBeenCalledTimes(18);
      expect(typeof retainedReportProgress).toBe("function");

      // Boundary: retained callback after hook settlement must be a strict no-op
      const settledAt = Date.now();
      await vi.advanceTimersByTimeAsync(350_000);
      retainedReportProgress?.("late:after-settle");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(Date.now() - settledAt).toBe(370_000);
      expect(onProgress).toHaveBeenCalledTimes(18);
      expect(watchdog.decide(Date.now())).toMatchObject({
        action: "stop",
        reason: "semantic_stall",
      });
    } finally {
      watchdog.close();
    }
  });

  it("still stops a genuinely stalled hook with semantic_stall after 360s via diagnosticOwner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    let stoppedReason: string | undefined;
    const watchdog = createSessionControllerWatchdog({
      startedAtMs: 0,
      isCurrent: () => stoppedReason === undefined,
      readPhase: () => (stoppedReason === undefined ? "active" : "terminal"),
      requestStop: (reason) => {
        stoppedReason = reason;
        return "requested";
      },
      expireCleanup: () => "settled",
    });
    const assertCurrent = () => {
      if (stoppedReason !== undefined) {
        throw new Error(`stopped:${stoppedReason}`);
      }
    };
    const owner = createDiagnosticEmbeddedRunOwner({
      runId: "run-dreaming-stall",
      sessionId: "sess-2",
      sessionKey: "agent:main:cron:dreaming-stall",
      watchdogAttempt: watchdog.attachAttempt({ assertCurrent }),
    });

    installHook(async (_event, ctx) => {
      await vi.advanceTimersByTimeAsync(22_000);
      ctx.reportProgress?.("dreaming:workspace_done");
      await vi.advanceTimersByTimeAsync(370_000);
      const decision = watchdog.decide(Date.now());
      if (decision.action === "stop") {
        stoppedReason = decision.reason;
      }
      ctx.reportProgress?.("dreaming:after_stop");
      return { handled: true, reason: "late" };
    });

    try {
      await expect(
        runBeforeAgentReplyForTurn({
          runId: "run-dreaming-stall",
          trigger: "cron",
          assertCurrent,
          diagnosticOwner: owner,
          event: { cleanedBody: "__openclaw_memory_core_short_term_promotion_dream__" },
          context: {
            runId: "run-dreaming-stall",
            sessionId: "sess-2",
            sessionKey: "agent:main:cron:dreaming-stall",
            trigger: "cron",
          },
        }),
      ).rejects.toThrow("stopped:semantic_stall");
      expect(stoppedReason).toBe("semantic_stall");
    } finally {
      closeDiagnosticEmbeddedRunOwner(owner);
      watchdog.close();
    }
  });
});
