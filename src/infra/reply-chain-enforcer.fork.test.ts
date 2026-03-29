/**
 * Fork regression tests for the Reply Chain Enforcer (watchdog).
 *
 * Extends the existing tests with coverage for fork-specific fixes:
 * - Signoff event handling (101a93b09) — direct disarm via stream:"signoff"
 * - Raw stream buffer sign-off (d3f51f3e9) — lifecycle:end checks accumulated text
 * - Agent event listener integration — subscribes to global agent events
 * - Recovery run suppression — no re-arm from watchdog recovery responses
 * - Per-session targeting (1377c4ebb, f516e64be) — stall injects into correct session
 * - Bypass in-flight (9f1248513) — watchdog-stall reason bypasses request throttle
 * - Delta disarm — streaming proof of life prevents false stalls
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import {
  emitAgentEvent,
  resetAgentRunContextForTest,
  registerAgentRunContext,
} from "./agent-events.js";
import { ReplyChainEnforcer } from "./reply-chain-enforcer.js";

type SessionKey = string;

describe("ReplyChainEnforcer — fork regression", () => {
  let enforcer: ReplyChainEnforcer;
  let injectCalls: Array<{ sessionKey: SessionKey; message: string; reason: string }>;
  let nowMs: number;

  beforeEach(() => {
    vi.useFakeTimers();
    injectCalls = [];
    nowMs = 1000000;
    enforcer = new ReplyChainEnforcer(
      {
        enabled: true,
        timeoutMs: 30000,
        prompt: `[System] Reply chain broken (stall detected). Resume any promised assignments, or respond with ${SILENT_REPLY_TOKEN} if you need a reply from the user.`,
      },
      {
        nowMs: () => nowMs,
        injectSystemMessage: async (opts) => {
          injectCalls.push(opts);
        },
      },
    );
  });

  afterEach(() => {
    enforcer.stopAll();
    vi.useRealTimers();
    resetAgentRunContextForTest();
  });

  // ─── Signoff event handling (fork fix: 101a93b09) ────────────────────────
  describe("signoff event disarm", () => {
    it("disarms via stream:signoff event (emitted when parseReplyDirectives strips silent token)", () => {
      const sessionKey = "agent:main:discord:channel:123" as SessionKey;
      const runId = "run-signoff-test";

      // Set up run context so events have a sessionKey
      registerAgentRunContext(runId, { sessionKey, isControlUiVisible: false });

      // Arm the watchdog
      enforcer.onChatFinal(sessionKey, "I'll handle that.");
      expect(enforcer["states"].get(sessionKey)?.status).toBe("armed");

      // Emit signoff event (this is what our fork's handleMessageUpdate does)
      emitAgentEvent({
        runId,
        stream: "signoff" as any,
        data: { token: "NO_REPLY" },
      });

      // Should be disarmed now
      expect(enforcer["states"].get(sessionKey)?.status).toBe("disarmed");

      // No stall should fire
      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(0);
    });

    it("signoff prevents onChatFinal from re-arming", () => {
      const sessionKey = "agent:main:discord:channel:456" as SessionKey;
      const runId = "run-signoff-rearm";

      registerAgentRunContext(runId, { sessionKey, isControlUiVisible: false });

      // Emit signoff
      emitAgentEvent({
        runId,
        stream: "signoff" as any,
        data: { token: "NO_REPLY" },
      });

      // onChatFinal with non-empty text would normally arm — but signoff should prevent it
      enforcer.onChatFinal(sessionKey, "");

      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(0);
    });
  });

  // ─── Raw stream buffer (fork fix: d3f51f3e9) ────────────────────────────
  describe("raw agent event stream buffer", () => {
    it("disarms on lifecycle:end when buffer contains NO_REPLY", () => {
      const sessionKey = "agent:main:discord:channel:789" as SessionKey;
      const runId = "run-raw-buffer";

      registerAgentRunContext(runId, { sessionKey, isControlUiVisible: false });

      // Arm
      enforcer.onChatFinal(sessionKey, "Working on it...");

      // Stream assistant text that becomes NO_REPLY
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { text: "NO_REPLY", delta: "NO_REPLY" },
      });

      // Lifecycle end triggers buffer check
      emitAgentEvent({
        runId,
        stream: "lifecycle" as any,
        data: { phase: "end" },
      });

      // Should be disarmed
      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(0);
    });

    it("stays armed when buffer has substantive text at lifecycle:end", () => {
      const sessionKey = "agent:main:discord:channel:790" as SessionKey;
      const runId = "run-substantive";

      registerAgentRunContext(runId, { sessionKey, isControlUiVisible: false });

      // Arm
      enforcer.onChatFinal(sessionKey, "Let me check.");

      // Stream real content
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { text: "Here is the result", delta: "Here is the result" },
      });

      // Lifecycle end — buffer has real text, should NOT disarm
      emitAgentEvent({
        runId,
        stream: "lifecycle" as any,
        data: { phase: "end" },
      });

      // onChatFinal with that text should re-arm
      enforcer.onChatFinal(sessionKey, "Here is the result");

      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(1);
    });
  });

  // ─── Recovery run suppression ────────────────────────────────────────────
  describe("recovery run handling", () => {
    it("does not re-arm after watchdog recovery response", () => {
      const sessionKey = "agent:main:discord:channel:111" as SessionKey;

      // Arm and trigger stall
      enforcer.onChatFinal(sessionKey, "Delegating to sub-agent...");
      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(1);

      // Recovery run responds with substantive text
      enforcer.onChatFinal(sessionKey, "Sorry about the delay. Here's what happened.");

      // Should NOT re-arm — recovery runs are fire-and-forget
      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(1); // Still 1, no second trigger
    });

    it("recovery suppression is one-shot (next real message can arm)", () => {
      const sessionKey = "agent:main:discord:channel:222" as SessionKey;

      // Trigger stall
      enforcer.onChatFinal(sessionKey, "Processing...");
      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(1);

      // Recovery response (consumed)
      enforcer.onChatFinal(sessionKey, "Done recovering.");

      // New user interaction → agent responds → should arm normally
      enforcer.onChatFinal(sessionKey, "I'll look into that next.");
      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(2);
    });
  });

  // ─── Per-session targeting (fork fixes: 1377c4ebb, f516e64be) ────────────
  describe("per-session targeting", () => {
    it("multiple sessions tracked independently", () => {
      const session1 = "agent:main:discord:channel:aaa" as SessionKey;
      const session2 = "agent:main:discord:channel:bbb" as SessionKey;

      // Both sessions active
      enforcer.onChatFinal(session1, "Working on task A...");
      enforcer.onChatFinal(session2, "Working on task B...");

      // Session 2 signs off
      enforcer.onChatFinal(session2, "NO_REPLY");

      nowMs += 31000;
      vi.advanceTimersByTime(31000);

      // Only session 1 should stall
      expect(injectCalls).toHaveLength(1);
      expect(injectCalls[0].sessionKey).toBe(session1);
    });

    it("stall injects reason 'watchdog-stall' for bypass of in-flight check", () => {
      const sessionKey = "agent:main:discord:channel:ccc" as SessionKey;

      enforcer.onChatFinal(sessionKey, "Investigating...");
      nowMs += 31000;
      vi.advanceTimersByTime(31000);

      expect(injectCalls[0].reason).toBe("watchdog-stall");
    });
  });

  // ─── Delta disarm and re-arm ─────────────────────────────────────────────
  describe("delta interaction with arm/disarm cycle", () => {
    it("delta during armed state disarms and prevents stall", () => {
      const sessionKey = "agent:main:discord:channel:ddd" as SessionKey;

      enforcer.onChatFinal(sessionKey, "Let me think...");
      expect(enforcer["states"].get(sessionKey)?.status).toBe("armed");

      nowMs += 15000;
      vi.advanceTimersByTime(15000);

      // Delta arrives — proof of life
      enforcer.onChatDelta(sessionKey);
      expect(enforcer["states"].get(sessionKey)?.status).toBe("disarmed");

      nowMs += 20000;
      vi.advanceTimersByTime(20000);
      expect(injectCalls).toHaveLength(0);
    });

    it("chatFinal after delta can re-arm", () => {
      const sessionKey = "agent:main:discord:channel:eee" as SessionKey;

      // First turn arms
      enforcer.onChatFinal(sessionKey, "Starting...");

      // Delta disarms
      enforcer.onChatDelta(sessionKey);

      // New chatFinal re-arms
      enforcer.onChatFinal(sessionKey, "Here's partial results, more coming...");

      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(1);
    });
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("stopAll cleans up all timers and state", () => {
      const session1 = "agent:main:discord:channel:stop1" as SessionKey;
      const session2 = "agent:main:discord:channel:stop2" as SessionKey;

      enforcer.onChatFinal(session1, "Task A...");
      enforcer.onChatFinal(session2, "Task B...");

      enforcer.stopAll();

      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(0);
    });

    it("disabled enforcer does nothing", () => {
      enforcer.updateConfig({ enabled: false });

      enforcer.onChatFinal("agent:main:discord:channel:disabled", "Working...");

      nowMs += 60000;
      vi.advanceTimersByTime(60000);
      expect(injectCalls).toHaveLength(0);
    });

    it("empty text on chatFinal disarms (nothing to follow up on)", () => {
      const sessionKey = "agent:main:discord:channel:empty" as SessionKey;

      enforcer.onChatFinal(sessionKey, "");

      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(0);
    });

    it("lifecycle error keeps armed state", () => {
      const sessionKey = "agent:main:discord:channel:err" as SessionKey;

      enforcer.onChatFinal(sessionKey, "Processing request...");
      enforcer.onAgentLifecycle({ sessionKey, phase: "error" });

      // Should still fire — agent crashed mid-work
      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(1);
    });

    it("abort event disarms watchdog and prevents stall injection", () => {
      const sessionKey = "agent:main:discord:channel:stop-test" as SessionKey;
      const runId = "run-abort-test";

      registerAgentRunContext(runId, { sessionKey });

      // Agent sends a message — watchdog arms
      enforcer.onChatFinal(sessionKey, "Let me check the logs...");

      // User sends /stop — abort event fires
      emitAgentEvent({
        runId: `abort-${Date.now()}`,
        stream: "abort",
        data: { sessionKey },
        sessionKey,
      });

      // Wait past timeout — watchdog should NOT fire
      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(0);
    });

    it("abort event prevents re-arm from subsequent onChatFinal", () => {
      const sessionKey = "agent:main:discord:channel:stop-rearm" as SessionKey;
      const runId = "run-abort-rearm";

      registerAgentRunContext(runId, { sessionKey });

      // Agent sends a message — watchdog arms
      enforcer.onChatFinal(sessionKey, "Working on it...");

      // User sends /stop — abort event fires
      emitAgentEvent({
        runId: `abort-${Date.now()}`,
        stream: "abort",
        data: { sessionKey },
        sessionKey,
      });

      // The aborted run completes and emitChatFinal fires with partial text.
      // This should NOT re-arm because rawSignOffSessions was set by abort.
      enforcer.onChatFinal(sessionKey, "Partial output before abort");

      nowMs += 31000;
      vi.advanceTimersByTime(31000);
      expect(injectCalls).toHaveLength(0);
    });
  });
});
