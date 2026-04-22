import { describe, expect, it, vi } from "vitest";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

function makeTypingController(isActiveResult = false): TypingController {
  return {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => isActiveResult),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
  };
}

describe("createTypingSignaler", () => {
  // Test A: signalReasoningDelta with mode="thinking" and no prior text starts typing
  // (regression: hasRenderableText=false must NOT block)
  it("signalReasoningDelta starts typing even when hasRenderableText is false", async () => {
    const typing = makeTypingController(false);
    const signaler = createTypingSignaler({ typing, mode: "thinking", isHeartbeat: false });

    // Do NOT call signalTextDelta first — hasRenderableText remains false
    await signaler.signalReasoningDelta();

    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
  });

  // Test B: signalRunStart with mode="instant" calls startTypingLoop immediately
  it("signalRunStart with mode=instant calls startTypingLoop immediately", async () => {
    const typing = makeTypingController(false);
    const signaler = createTypingSignaler({ typing, mode: "instant", isHeartbeat: false });

    await signaler.signalRunStart();

    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
  });

  // Test B (message): signalRunStart with mode="message" also calls startTypingLoop
  it("signalRunStart with mode=message calls startTypingLoop", async () => {
    const typing = makeTypingController(false);
    const signaler = createTypingSignaler({ typing, mode: "message", isHeartbeat: false });

    await signaler.signalRunStart();

    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
  });

  // Test B2: signalRunStart with mode="thinking" also calls startTypingLoop
  it("signalRunStart with mode=thinking calls startTypingLoop", async () => {
    const typing = makeTypingController(false);
    const signaler = createTypingSignaler({ typing, mode: "thinking", isHeartbeat: false });

    await signaler.signalRunStart();

    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
  });

  // Test C: signalToolStart with any non-"never" mode starts typing loop if not already active
  it("signalToolStart with non-never mode starts typing loop when not already active", async () => {
    for (const mode of ["instant", "message", "thinking"] as const) {
      const typing = makeTypingController(false);
      const signaler = createTypingSignaler({ typing, mode, isHeartbeat: false });

      await signaler.signalToolStart();

      expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    }
  });
});
