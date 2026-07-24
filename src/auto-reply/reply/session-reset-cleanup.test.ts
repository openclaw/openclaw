// Tests session reset cleanup for stale files and persisted state.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSession,
  listFinishedSessions,
  markExited,
} from "../../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../../agents/bash-process-registry.test-support.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../../agents/embedded-agent-runner/session-prompt-state.js";
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
  resetSystemEventsForTest();
  resetProcessRegistryForTests();
});

describe("clearSessionResetRuntimeState", () => {
  it("disposes prompt projections with the archived session", () => {
    const state = getEmbeddedSessionPromptState("old-session");
    state.sentUserTurnIds.add("sent-user-turn");

    clearSessionResetRuntimeState(["old-session"]);

    expect(getEmbeddedSessionPromptState("old-session")).not.toBe(state);
  });

  it("clears reset queues and drains system events for normalized keys", () => {
    enqueueSystemEvent("stale alpha", { sessionKey: "alpha" });
    enqueueSystemEvent("stale beta", { sessionKey: "beta" });
    enqueueSystemEvent("fresh gamma", { sessionKey: "gamma" });

    const result = clearSessionResetRuntimeState([" alpha ", undefined, " ", "alpha", "beta"]);

    expect(result.keys).toEqual(["alpha", "beta"]);
    expect(result.systemEventsCleared).toBe(2);
    expect(result.finishedProcessSessionsCleared).toBe(0);
    expect(peekSystemEvents("alpha")).toStrictEqual([]);
    expect(peekSystemEvents("beta")).toStrictEqual([]);
    expect(peekSystemEvents("gamma")).toEqual(["fresh gamma"]);
  });

  it("purges finished bash process records scoped to the reset session keys", () => {
    const scoped = createProcessSessionFixture({
      id: "scoped-finished",
      scopeKey: "agent:main:main",
      backgrounded: true,
      child: { pid: 1, removeAllListeners: vi.fn() } as unknown as ChildProcessWithoutNullStreams,
    });
    const shared = createProcessSessionFixture({
      id: "shared-finished",
      scopeKey: "chat:bash",
      backgrounded: true,
      child: { pid: 2, removeAllListeners: vi.fn() } as unknown as ChildProcessWithoutNullStreams,
    });
    addSession(scoped);
    markExited(scoped, 0, null, "completed");
    addSession(shared);
    markExited(shared, 0, null, "completed");

    const result = clearSessionResetRuntimeState(["agent:main:main"]);

    expect(result.finishedProcessSessionsCleared).toBe(1);
    expect(listFinishedSessions().map((session) => session.id)).toEqual(["shared-finished"]);
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
      activeReplySessionId: "old-session",
    });

    expect(operation.phase).toBe("queued");
    expect(replyRunRegistry.get("agent:main:slack:room:1")).toBe(operation);
  });
});
