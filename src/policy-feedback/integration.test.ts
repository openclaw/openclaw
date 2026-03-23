/**
 * Integration tests for the policy feedback hook bridge.
 *
 * Validates that:
 * - Hooks register and fire correctly with the internal hook system
 * - Passive mode logs actions/outcomes without changing behavior
 * - Engine failures do not break the main flow
 * - Feature flags independently control each integration point
 * - Cleanup/unsubscribe works correctly
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { clearPolicyFeedbackHookState, registerPolicyFeedbackHooks } from "./hooks.js";
import type { PolicyFeedbackEngine, PolicyMode } from "./types.js";

// ---------------------------------------------------------------------------
// Mock engine factory
// ---------------------------------------------------------------------------

type MockEngine = PolicyFeedbackEngine & {
  logAction: ReturnType<typeof vi.fn>;
  logOutcome: ReturnType<typeof vi.fn>;
  rankCandidates: ReturnType<typeof vi.fn>;
  getPolicyHints: ReturnType<typeof vi.fn>;
  recomputeAggregates: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
};

function createMockEngine(overrides?: Partial<PolicyFeedbackEngine>): MockEngine {
  return {
    logAction: vi.fn().mockResolvedValue({ actionId: "test-action-001" }),
    logOutcome: vi.fn().mockResolvedValue(undefined),
    rankCandidates: vi.fn().mockResolvedValue([]),
    getPolicyHints: vi.fn().mockResolvedValue({
      recommendation: "proceed",
      reasons: [],
      fatigueLevel: 0,
      activeConstraints: [],
      mode: "passive",
    }),
    recomputeAggregates: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({
      mode: "passive",
      actionLogSize: 0,
      outcomeLogSize: 0,
      aggregatesStale: true,
      constraintRulesLoaded: 0,
    }),
    ...overrides,
  } as MockEngine;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMessageReceivedEvent(sessionKey: string, from = "+1234567890") {
  return createInternalHookEvent("message", "received", sessionKey, {
    from,
    content: "Hello!",
    channelId: "whatsapp",
    accountId: "acc-1",
    conversationId: "conv-1",
  });
}

function createMessageSentEvent(sessionKey: string, to = "+1234567890") {
  return createInternalHookEvent("message", "sent", sessionKey, {
    to,
    content: "Hi there!",
    channelId: "whatsapp",
    accountId: "acc-1",
    success: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("policy-feedback hooks integration", () => {
  let engine: MockEngine;
  let unsub: () => void;
  let currentMode: PolicyMode;

  beforeEach(() => {
    clearInternalHooks();
    clearPolicyFeedbackHookState();
    engine = createMockEngine();
    currentMode = "passive";
    unsub = registerPolicyFeedbackHooks({
      engine,
      getMode: () => currentMode,
      agentId: "agent-default",
    });
  });

  afterEach(() => {
    unsub();
    clearInternalHooks();
    clearPolicyFeedbackHookState();
  });

  // -------------------------------------------------------------------------
  // Basic hook registration
  // -------------------------------------------------------------------------

  it("registers message:received and message:sent hooks", async () => {
    const receivedEvent = createMessageReceivedEvent("session-1");
    await triggerInternalHook(receivedEvent);

    // The received handler stores a pending action but does not call logAction
    expect(engine.logAction).not.toHaveBeenCalled();

    const sentEvent = createMessageSentEvent("session-1");
    await triggerInternalHook(sentEvent);

    // The sent handler promotes the pending action and logs it
    expect(engine.logAction).toHaveBeenCalledTimes(1);
    expect(engine.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-default",
        sessionKey: "session-1",
        actionType: "agent_reply",
        channelId: "whatsapp",
      }),
    );
  });

  it("logs delivery_success outcome on successful message send", async () => {
    const received = createMessageReceivedEvent("session-2");
    await triggerInternalHook(received);

    const sent = createMessageSentEvent("session-2");
    await triggerInternalHook(sent);

    expect(engine.logOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "test-action-001",
        agentId: "agent-default",
        outcomeType: "delivery_success",
        value: 1,
      }),
    );
  });

  it("logs delivery_failure outcome when message send fails", async () => {
    const received = createMessageReceivedEvent("session-3");
    await triggerInternalHook(received);

    const sent = createInternalHookEvent("message", "sent", "session-3", {
      to: "+1234567890",
      content: "Hi",
      channelId: "telegram",
      success: false,
    });
    await triggerInternalHook(sent);

    expect(engine.logOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomeType: "delivery_failure",
        value: 0,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Passive mode: zero behavior change
  // -------------------------------------------------------------------------

  it("passive mode only logs — no ranking or suppression calls", async () => {
    currentMode = "passive";

    await triggerInternalHook(createMessageReceivedEvent("session-4"));
    await triggerInternalHook(createMessageSentEvent("session-4"));

    expect(engine.logAction).toHaveBeenCalledTimes(1);
    expect(engine.logOutcome).toHaveBeenCalled();
    // No ranking or hints calls from the hooks
    expect(engine.rankCandidates).not.toHaveBeenCalled();
    expect(engine.getPolicyHints).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Off mode: skip all
  // -------------------------------------------------------------------------

  it("off mode skips all hook processing", async () => {
    currentMode = "off";

    await triggerInternalHook(createMessageReceivedEvent("session-5"));
    await triggerInternalHook(createMessageSentEvent("session-5"));

    expect(engine.logAction).not.toHaveBeenCalled();
    expect(engine.logOutcome).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Engine failure: no disruption
  // -------------------------------------------------------------------------

  it("engine.logAction failure does not throw or disrupt hooks", async () => {
    const failingEngine = createMockEngine({
      logAction: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    unsub();
    clearInternalHooks();
    unsub = registerPolicyFeedbackHooks({
      engine: failingEngine,
      getMode: () => "passive",
      agentId: "agent-default",
    });

    // Should not throw
    await triggerInternalHook(createMessageReceivedEvent("session-6"));
    await triggerInternalHook(createMessageSentEvent("session-6"));

    expect(failingEngine.logAction).toHaveBeenCalled();
    // The hook catches the error internally
  });

  it("engine.logOutcome failure does not throw or disrupt hooks", async () => {
    const failingEngine = createMockEngine({
      logOutcome: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    unsub();
    clearInternalHooks();
    unsub = registerPolicyFeedbackHooks({
      engine: failingEngine,
      getMode: () => "passive",
      agentId: "agent-default",
    });

    await triggerInternalHook(createMessageReceivedEvent("session-7"));
    await triggerInternalHook(createMessageSentEvent("session-7"));

    // logAction succeeds, logOutcome fails silently
    expect(failingEngine.logAction).toHaveBeenCalled();
    expect(failingEngine.logOutcome).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Outcome correlation (user_replied)
  // -------------------------------------------------------------------------

  it("correlates user reply with prior agent action", async () => {
    // Agent sends a message
    await triggerInternalHook(createMessageSentEvent("session-8"));

    // User replies
    await triggerInternalHook(createMessageReceivedEvent("session-8"));

    // Should log user_replied outcome
    expect(engine.logOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "test-action-001",
        outcomeType: "user_replied",
      }),
    );
  });

  it("does not double-correlate the same action", async () => {
    await triggerInternalHook(createMessageSentEvent("session-9"));

    // First user reply
    await triggerInternalHook(createMessageReceivedEvent("session-9"));
    // Second user reply — should not re-correlate the same action
    await triggerInternalHook(createMessageReceivedEvent("session-9"));

    const userRepliedCalls = (engine.logOutcome as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[0] as { outcomeType: string }).outcomeType === "user_replied",
    );
    expect(userRepliedCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Unsubscribe / cleanup
  // -------------------------------------------------------------------------

  it("unsubscribe removes hooks and clears state", async () => {
    unsub();

    // After unsubscribe, hooks should not fire
    await triggerInternalHook(createMessageReceivedEvent("session-10"));
    await triggerInternalHook(createMessageSentEvent("session-10"));

    expect(engine.logAction).not.toHaveBeenCalled();
    expect(engine.logOutcome).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Message sent without prior received (no pending inbound)
  // -------------------------------------------------------------------------

  it("handles message sent without a preceding message received", async () => {
    // Send without a prior received event
    await triggerInternalHook(createMessageSentEvent("session-11"));

    expect(engine.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "agent_reply",
        metadata: expect.objectContaining({
          hadPendingInbound: false,
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Feature flag independence
  // -------------------------------------------------------------------------

  it("mode change at runtime is respected on subsequent events", async () => {
    currentMode = "passive";
    await triggerInternalHook(createMessageReceivedEvent("session-12"));
    await triggerInternalHook(createMessageSentEvent("session-12"));
    expect(engine.logAction).toHaveBeenCalledTimes(1);

    // Switch to off — next events should be skipped
    currentMode = "off";
    await triggerInternalHook(createMessageReceivedEvent("session-13"));
    await triggerInternalHook(createMessageSentEvent("session-13"));
    expect(engine.logAction).toHaveBeenCalledTimes(1); // still 1
  });

  // -------------------------------------------------------------------------
  // Non-message events are ignored
  // -------------------------------------------------------------------------

  it("ignores non-message hook events", async () => {
    const gatewayEvent = createInternalHookEvent("gateway", "startup", "session-14", {});
    await triggerInternalHook(gatewayEvent);

    const commandEvent = createInternalHookEvent("command", "new", "session-15", {});
    await triggerInternalHook(commandEvent);

    expect(engine.logAction).not.toHaveBeenCalled();
    expect(engine.logOutcome).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Multiple sessions independence
  // -------------------------------------------------------------------------

  it("tracks actions independently per session key", async () => {
    await triggerInternalHook(createMessageReceivedEvent("session-A"));
    await triggerInternalHook(createMessageReceivedEvent("session-B"));

    await triggerInternalHook(createMessageSentEvent("session-A"));
    expect(engine.logAction).toHaveBeenCalledTimes(1);
    expect(engine.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "session-A" }),
    );

    await triggerInternalHook(createMessageSentEvent("session-B"));
    expect(engine.logAction).toHaveBeenCalledTimes(2);
    expect(engine.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "session-B" }),
    );
  });
});

// ---------------------------------------------------------------------------
// initializePolicyFeedback tests
// ---------------------------------------------------------------------------

describe("initializePolicyFeedback", () => {
  beforeEach(() => {
    clearInternalHooks();
    clearPolicyFeedbackHookState();
  });

  afterEach(() => {
    clearInternalHooks();
    clearPolicyFeedbackHookState();
  });

  it("returns a handle with shutdown function even when mode is off", async () => {
    const { initializePolicyFeedback } = await import("./init.js");

    const handle = await initializePolicyFeedback({
      agentId: "agent-test",
      mode: "off",
    });

    expect(handle.mode).toBe("off");
    expect(handle.engine).toBeNull();
    expect(typeof handle.shutdown).toBe("function");
    // Should not throw
    handle.shutdown();
  });
});
