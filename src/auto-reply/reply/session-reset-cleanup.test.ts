// Tests session reset cleanup for stale files and persisted state.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import {
  createReplyOperation,
  replyRunRegistry,
  testing as replyRunTesting,
} from "./reply-run-registry.js";
import { clearSessionResetRuntimeState } from "./session-reset-cleanup.js";

afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  resetSystemEventsForTest();
});

describe("clearSessionResetRuntimeState", () => {
  it("clears reset queues and drains system events for normalized keys", () => {
    enqueueSystemEvent("stale alpha", { sessionKey: "alpha" });
    enqueueSystemEvent("stale beta", { sessionKey: "beta" });
    enqueueSystemEvent("fresh gamma", { sessionKey: "gamma" });

    const result = clearSessionResetRuntimeState([" alpha ", undefined, " ", "alpha", "beta"]);

    expect(result.keys).toEqual(["alpha", "beta"]);
    expect(result.systemEventsCleared).toBe(2);
    expect(peekSystemEvents("alpha")).toStrictEqual([]);
    expect(peekSystemEvents("beta")).toStrictEqual([]);
    expect(peekSystemEvents("gamma")).toEqual(["fresh gamma"]);
  });

  it("releases an active reply operation owned by the archived reset session id", () => {
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
    });
    operation.setPhase("running");

    const result = clearSessionResetRuntimeState(["agent:main:room:1", "old-session"], {
      activeReplySessionIds: ["old-session"],
    });

    expect(result.activeReplyRunsCleared).toBe(1);
    expect(cancel).toHaveBeenCalledWith("restart");
    expect(replyRunRegistry.isActive("agent:main:room:1")).toBe(false);
  });

  it("leaves queued reservations so session init can rebind them", () => {
    createReplyOperation({
      sessionKey: "agent:main:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });
    // default phase is "queued"

    const result = clearSessionResetRuntimeState(["agent:main:room:1", "old-session"], {
      activeReplySessionIds: ["old-session"],
    });

    expect(result.activeReplyRunsCleared).toBe(0);
    expect(replyRunRegistry.get("agent:main:room:1")?.phase).toBe("queued");
  });

  it("does not clear a fresh active reply whose sessionId does not match the archived id", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:room:1",
      sessionId: "new-session",
      resetTriggered: false,
    });
    operation.setPhase("running");

    const result = clearSessionResetRuntimeState(["agent:main:room:1", "old-session"], {
      activeReplySessionIds: ["old-session"],
    });

    expect(result.activeReplyRunsCleared).toBe(0);
    expect(replyRunRegistry.get("agent:main:room:1")).toBe(operation);
  });
});
