import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  abortActiveReplyRuns,
  createReplyOperation,
  isReplyRunActiveForSessionId,
  queueReplyRunMessage,
  replyRunRegistry,
  resolveActiveReplyRunSessionId,
  waitForReplyRunEndBySessionId,
} from "./reply-run-registry.js";

describe("reply run registry", () => {
  afterEach(() => {
    __testing.resetReplyRunRegistry();
    vi.restoreAllMocks();
  });

  it("keeps ownership stable by sessionKey while sessionId rotates", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-old",
        resetTriggered: false,
      });

      const oldWaitPromise = waitForReplyRunEndBySessionId("session-old", 1_000);

      operation.updateSessionId("session-new");

      expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);
      expect(resolveActiveReplyRunSessionId("agent:main:main")).toBe("session-new");
      expect(isReplyRunActiveForSessionId("session-old")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-new")).toBe(true);

      let settled = false;
      void oldWaitPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      operation.complete();

      await expect(oldWaitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("clears queued operations immediately on user abort", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-queued",
      resetTriggered: false,
    });

    expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);

    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
  });

  it("queues messages only through the active running backend", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });

    expect(queueReplyRunMessage("session-running", "before running")).toBe(false);

    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("hello");
  });

  it("aborts compacting runs through the registry compatibility helper", () => {
    const compactingOperation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-compacting",
      resetTriggered: false,
    });
    compactingOperation.setPhase("preflight_compacting");

    const runningOperation = createReplyOperation({
      sessionKey: "agent:main:other",
      sessionId: "session-running",
      resetTriggered: false,
    });
    runningOperation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "compacting" })).toBe(true);
    expect(compactingOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(runningOperation.result).toBeNull();
  });
});

describe("createReplyOperation with force option", () => {
  afterEach(() => {
    __testing.resetReplyRunRegistry();
  });

  it("force-supersedes an existing operation for the same session key", () => {
    const existing = createReplyOperation({
      sessionKey: "agent:main:force-test",
      sessionId: "session-old",
      resetTriggered: false,
    });
    existing.setPhase("running");

    const replacement = createReplyOperation({
      sessionKey: "agent:main:force-test",
      sessionId: "session-new",
      resetTriggered: false,
      force: true,
    });

    // Old operation should be aborted
    expect(existing.result).toEqual({ kind: "aborted", code: "aborted_by_user" });

    // New operation should be active
    expect(replacement.phase).toBe("queued");
    expect(replyRunRegistry.isActive("agent:main:force-test")).toBe(true);
    expect(replacement.sessionId).toBe("session-new");
  });

  it("throws ReplyRunAlreadyActiveError without force", () => {
    createReplyOperation({
      sessionKey: "agent:main:no-force",
      sessionId: "session-existing",
      resetTriggered: false,
    });

    expect(() =>
      createReplyOperation({
        sessionKey: "agent:main:no-force",
        sessionId: "session-new",
        resetTriggered: false,
      }),
    ).toThrow("Reply run already active");
  });

  it("force with no existing operation works normally", () => {
    const op = createReplyOperation({
      sessionKey: "agent:main:force-empty",
      sessionId: "session-1",
      resetTriggered: false,
      force: true,
    });

    expect(op.phase).toBe("queued");
    expect(op.sessionId).toBe("session-1");
  });

  it("force: stale operation's clearState does not delete replacement", () => {
    // Create the original operation and advance it to running
    const existing = createReplyOperation({
      sessionKey: "agent:main:force-race",
      sessionId: "session-old",
      resetTriggered: false,
    });
    existing.setPhase("running");

    // Force-supersede it with a new operation
    const replacement = createReplyOperation({
      sessionKey: "agent:main:force-race",
      sessionId: "session-new",
      resetTriggered: false,
      force: true,
    });
    replacement.setPhase("running");

    // Now simulate the old operation's finally block running complete()
    // (which calls clearState). This must NOT delete the replacement's entries.
    existing.complete();

    // Replacement should still be active
    expect(replyRunRegistry.isActive("agent:main:force-race")).toBe(true);
    expect(resolveActiveReplyRunSessionId("agent:main:force-race")).toBe(
      "session-new",
    );
  });

  it("force-supersede preserves rotated wait aliases for the replacement", async () => {
    vi.useFakeTimers();
    try {
      // Old operation with a rotated sessionId
      const existing = createReplyOperation({
        sessionKey: "agent:main:force-alias",
        sessionId: "session-v1",
        resetTriggered: false,
      });
      existing.setPhase("running");
      existing.updateSessionId("session-v2");

      // A waiter using the OLD sessionId (pre-rotation alias)
      const aliasWaitPromise = waitForReplyRunEndBySessionId("session-v1", 5_000);

      // Force-supersede
      const replacement = createReplyOperation({
        sessionKey: "agent:main:force-alias",
        sessionId: "session-v3",
        resetTriggered: false,
        force: true,
      });
      replacement.setPhase("running");

      // The alias waiter should NOT have resolved yet — the replacement is still running
      let settled = false;
      void aliasWaitPromise.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      // When replacement completes, alias waiter resolves
      replacement.complete();
      await expect(aliasWaitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
});
