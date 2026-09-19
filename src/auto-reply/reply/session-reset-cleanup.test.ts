// Tests session reset cleanup for stale files and persisted state.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../../agents/embedded-agent-runner/session-prompt-state.js";
import {
  enqueueExecSteeringCompletion,
  hasPendingExecSteeringItems,
  leasePendingExecSteeringItems,
  resetExecSteeringQueueForTest,
} from "../../agents/exec-steering-queue.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { clearSessionResetRuntimeState } from "./session-reset-cleanup.js";

afterEach(() => {
  clearEmbeddedSessionPromptStates(["old-session"]);
  replyRunTesting.resetReplyRunRegistry();
  resetDiagnosticRunActivityForTest();
  resetExecSteeringQueueForTest();
  resetSystemEventsForTest();
});

describe("clearSessionResetRuntimeState", () => {
  it("disposes prompt projections with the archived session", () => {
    const state = getEmbeddedSessionPromptState("old-session");
    state.sentUserTurnIds.add("sent-user-turn");

    clearSessionResetRuntimeState(["old-session"], { agentId: "main" });

    expect(getEmbeddedSessionPromptState("old-session")).not.toBe(state);
  });

  it("clears reset queues and drains system events for normalized keys", () => {
    enqueueSystemEvent("stale alpha", withSystemEventOwner({ sessionKey: "alpha" }, "main"));
    enqueueSystemEvent("stale beta", withSystemEventOwner({ sessionKey: "beta" }, "main"));
    enqueueSystemEvent("fresh gamma", withSystemEventOwner({ sessionKey: "gamma" }, "main"));

    const result = clearSessionResetRuntimeState([" alpha ", undefined, " ", "alpha", "beta"], {
      agentId: "main",
    });

    expect(result.keys).toEqual(["alpha", "beta"]);
    expect(result.systemEventsCleared).toBe(2);
    expect(peekSystemEvents("agent:main:alpha")).toStrictEqual([]);
    expect(peekSystemEvents("agent:main:beta")).toStrictEqual([]);
    expect(peekSystemEvents("agent:main:gamma")).toEqual(["fresh gamma"]);
  });

  it("preserves events owned by other agents during an agent-scoped reset", () => {
    enqueueSystemEvent("main", withSystemEventOwner({ sessionKey: "global" }, "main"));
    enqueueSystemEvent("alpha", withSystemEventOwner({ sessionKey: "global" }, "alpha"));
    enqueueSystemEvent("beta", withSystemEventOwner({ sessionKey: "global" }, "beta"));

    const result = clearSessionResetRuntimeState(["global", "agent:beta:global"], {
      agentId: " Alpha ",
    });

    expect(result.systemEventsCleared).toBe(1);
    expect(peekSystemEvents("agent:alpha:global")).toEqual([]);
    expect(peekSystemEvents("agent:main:global")).toEqual(["main"]);
    expect(peekSystemEvents("agent:beta:global")).toEqual(["beta"]);
  });

  it("retires pending and leased exec completions for the reset conversation", () => {
    enqueueExecSteeringCompletion({
      requesterSessionKey: "alpha",
      ownerAgentId: "main",
      occurrenceKey: "exec:stale001",
      execId: "stale001",
      status: "completed",
      exitLabel: "exit 0",
      text: "stale after reset",
    });
    // Leased by the conversation that is about to be reset.
    expect(
      leasePendingExecSteeringItems({
        requesterSessionKey: "alpha",
        ownerAgentId: "main",
        leaseId: "run-1:exec-steering",
      }),
    ).toBeDefined();

    clearSessionResetRuntimeState(["alpha"], { agentId: "main" });

    // The reset conversation's next turn leases nothing stale.
    expect(
      hasPendingExecSteeringItems({ requesterSessionKey: "alpha", ownerAgentId: "main" }),
    ).toBe(false);
    expect(
      leasePendingExecSteeringItems({
        requesterSessionKey: "alpha",
        ownerAgentId: "main",
        leaseId: "run-2:exec-steering",
      }),
    ).toBeUndefined();
  });

  it("releases active reply work owned by the archived reset session id", () => {
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
    });
    operation.setPhase("running");

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      agentId: "main",
      activeReplySessionId: "old-session",
    });

    expect(cancel).toHaveBeenCalledWith("restart");
    expect(replyRunRegistry.isActive("agent:main:slack:room:1")).toBe(false);
    const nextOperation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "new-session",
      resetTriggered: false,
    });
    expect(nextOperation.sessionId).toBe("new-session");
  });

  it("does not clear a fresh active reply under the same key when only the archived id is reset", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "new-session",
      resetTriggered: false,
    });
    operation.setPhase("running");

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      agentId: "main",
      activeReplySessionId: "old-session",
    });

    expect(replyRunRegistry.get("agent:main:slack:room:1")).toBe(operation);
  });

  it("does not clear a replacement admitted while the archived run is cancelling", () => {
    let replacement: ReturnType<typeof createReplyOperation> | undefined;
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel() {
        operation.complete();
        replacement = createReplyOperation({
          sessionKey: "agent:main:slack:room:1",
          sessionId: "old-session",
          resetTriggered: false,
        });
        replacement.setPhase("running");
      },
      isStreaming: () => false,
    });
    operation.setPhase("running");

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      agentId: "main",
      activeReplySessionId: "old-session",
    });

    expect(replacement).toBeDefined();
    expect(replyRunRegistry.get("agent:main:slack:room:1")).toBe(replacement);
  });

  it("leaves queued reservations for the archived id so session init can rebind them", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      agentId: "main",
      activeReplySessionId: "old-session",
    });

    expect(operation.phase).toBe("queued");
    expect(replyRunRegistry.get("agent:main:slack:room:1")).toBe(operation);
  });
});
