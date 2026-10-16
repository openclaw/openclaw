import { afterEach, describe, expect, it, vi } from "vitest";

const REPLY_RUN_STATE_KEY = Symbol.for("openclaw.replyRunRegistry");

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
});
