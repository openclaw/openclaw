import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  createReplyOperation,
  forceClearReplyRunBySessionId,
  queueReplyRunMessage,
  replyRunRegistry,
} from "./reply-run-registry.js";

describe("reply run registry – preflight compaction regression", () => {
  afterEach(() => {
    __testing.resetReplyRunRegistry();
    vi.restoreAllMocks();
  });

  /**
   * Regression test for: https://github.com/openclaw/openclaw/issues/76467
   *
   * Root cause: `queueReplyRunMessage` only accepted messages when
   * `operation.phase === "running"`, silently rejecting messages queued
   * during `preflight_compacting` or `memory_flushing`.
   *
   * Fix: expand accepting phases to include preflight_compacting and
   * memory_flushing, so webchat follow-up messages are not dropped.
   */
  it("queues messages during preflight_compacting phase", () => {
    const sessionId = "session-compacting-queue";

    const operation = createReplyOperation({
      sessionKey: "agent:main:webchat",
      sessionId,
      resetTriggered: false,
    });

    let compacting = true;
    const queueMock = vi.fn();
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      isCompacting: () => compacting,
      queueMessage: queueMock,
    });

    // Before fix: this returned false during preflight_compacting
    operation.setPhase("preflight_compacting");
    expect(queueReplyRunMessage(sessionId, "message during compaction")).toBe(true);
    expect(queueMock).toHaveBeenCalledWith("message during compaction");
  });

  it("queues messages during memory_flushing phase", () => {
    const sessionId = "session-flushing-queue";

    const operation = createReplyOperation({
      sessionKey: "agent:main:webchat",
      sessionId,
      resetTriggered: false,
    });

    const queueMock = vi.fn();
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: queueMock,
    });

    operation.setPhase("memory_flushing");
    expect(queueReplyRunMessage(sessionId, "message during flush")).toBe(true);
    expect(queueMock).toHaveBeenCalledWith("message during flush");
  });

  it("continues accepting messages after preflight_compacting transitions to running", () => {
    const sessionId = "session-transition";

    const operation = createReplyOperation({
      sessionKey: "agent:main:webchat",
      sessionId,
      resetTriggered: false,
    });

    const queueMock = vi.fn();
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: queueMock,
    });

    // Queue during compaction
    operation.setPhase("preflight_compacting");
    expect(queueReplyRunMessage(sessionId, "during compaction")).toBe(true);

    // Transition to running
    operation.setPhase("running");
    expect(queueReplyRunMessage(sessionId, "after compaction")).toBe(true);

    expect(queueMock).toHaveBeenCalledTimes(2);
  });

  it("force-clears preflight_compacting operation without requiring restart", () => {
    const sessionId = "session-force-clear";

    const operation = createReplyOperation({
      sessionKey: "agent:main:webchat",
      sessionId,
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      isCompacting: () => true,
    });

    operation.setPhase("preflight_compacting");

    // Force-clear must work even during preflight_compacting
    const cleared = forceClearReplyRunBySessionId(sessionId, new Error("compaction timeout"));
    expect(cleared).toBe(true);
    expect(replyRunRegistry.isActive("agent:main:webchat")).toBe(false);
  });

  it("completes cleanly after draining queued messages post-compaction", async () => {
    vi.useFakeTimers();
    try {
      const sessionId = "session-clean-drain";

      const operation = createReplyOperation({
        sessionKey: "agent:main:webchat",
        sessionId,
        resetTriggered: false,
      });

      const queueMock = vi.fn();
      operation.attachBackend({
        kind: "embedded",
        cancel: vi.fn(),
        isStreaming: () => true,
        isCompacting: () => false,
        queueMessage: queueMock,
      });

      // Queue while compacting
      operation.setPhase("preflight_compacting");
      expect(queueReplyRunMessage(sessionId, "queued during compaction")).toBe(true);

      // Transition to running and complete
      operation.setPhase("running");
      operation.complete();

      await vi.runOnlyPendingTimersAsync();
      expect(replyRunRegistry.isActive("agent:main:webchat")).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
});
