import { afterEach, describe, expect, it, vi } from "vitest";

const REPLY_RUN_STATE_KEY = Symbol.for("openclaw.replyRunRegistry");

type RetainedReplyRunState = {
  activeRunsByKey: Map<string, unknown>;
  activeSessionIdsByKey: Map<string, string>;
  activeKeysBySessionId: Map<string, string>;
  waitKeysBySessionId: Map<string, string>;
  waitersByKey: Map<string, Set<unknown>>;
  followupAdmissionBarriersByKey: Map<string, unknown>;
  successorAdmissionBarriersByKey: Map<string, unknown>;
  sourceTurnByKey?: Map<string, string>;
  evictOperationByOperation: WeakMap<object, () => void>;
  executionStartedOperations: WeakSet<object>;
};

function buildRetainedStateWithoutSourceTurnByKey(): RetainedReplyRunState {
  // Retained state from before source-turn bindings were introduced.
  return {
    activeRunsByKey: new Map(),
    activeSessionIdsByKey: new Map(),
    activeKeysBySessionId: new Map(),
    waitKeysBySessionId: new Map(),
    waitersByKey: new Map(),
    followupAdmissionBarriersByKey: new Map(),
    successorAdmissionBarriersByKey: new Map(),
    evictOperationByOperation: new WeakMap(),
    executionStartedOperations: new WeakSet(),
  };
}

afterEach(() => {
  const store = globalThis as Record<PropertyKey, unknown>;
  delete store[REPLY_RUN_STATE_KEY];
  vi.resetModules();
});

describe("reply run registry retained singleton", () => {
  it("retains a live source binding across module reload and clears it with its owner", async () => {
    const { createReplyOperation, replyRunRegistry } = await import("./reply-run-registry.js");
    const key = "agent:main:reload";
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: "reload-session",
      resetTriggered: false,
    });
    operation.setPhase("running");
    replyRunRegistry.bindSourceTurnId(operation, "reload-source");
    let reloaded: typeof import("./reply-run-registry.js");
    try {
      vi.resetModules();
      reloaded = await import("./reply-run-registry.js");
      expect(reloaded.replyRunRegistry.get(key)).toBe(operation);
      expect(reloaded.replyRunRegistry.getSourceTurnId(key)).toBe("reload-source");
    } finally {
      operation.complete();
    }
    expect(reloaded.replyRunRegistry.isActive(key)).toBe(false);
    expect(reloaded.replyRunRegistry.getSourceTurnId(key)).toBeUndefined();
  });

  it("backfills sourceTurnByKey when the retained singleton predates the field", async () => {
    (globalThis as Record<PropertyKey, unknown>)[REPLY_RUN_STATE_KEY] =
      buildRetainedStateWithoutSourceTurnByKey();

    vi.resetModules();
    const { createReplyOperation, replyRunRegistry } = await import("./reply-run-registry.js");

    const operation = createReplyOperation({
      sessionKey: "agent:main:legacy",
      sessionId: "legacy-session",
      resetTriggered: false,
    });
    replyRunRegistry.bindSourceTurnId(operation, "source-legacy-1");
    expect(replyRunRegistry.getSourceTurnId("agent:main:legacy")).toBe("source-legacy-1");
    expect(replyRunRegistry.get("agent:main:legacy")).toBe(operation);
    operation.complete();
    expect(replyRunRegistry.getSourceTurnId("agent:main:legacy")).toBeUndefined();
    expect(replyRunRegistry.isActive("agent:main:legacy")).toBe(false);
  });
});
