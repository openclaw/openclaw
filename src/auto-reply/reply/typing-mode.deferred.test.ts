import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TypingController } from "./typing.js";
import { createTypingSignaler, resolveTypingMode } from "./typing-mode.js";

function createMockTyping(): TypingController {
  return {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
  };
}

describe("deferred typing mode", () => {
  let typing: ReturnType<typeof createMockTyping>;

  beforeEach(() => {
    typing = createMockTyping();
  });

  it("resolveTypingMode returns deferred when configured", () => {
    expect(
      resolveTypingMode({
        configured: "deferred",
        isGroupChat: true,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("deferred");
  });

  it("does not start typing on run start", async () => {
    const signaler = createTypingSignaler({ typing, mode: "deferred", isHeartbeat: false });
    await signaler.signalRunStart();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("does not start typing for NO_REPLY streamed character by character", async () => {
    const signaler = createTypingSignaler({ typing, mode: "deferred", isHeartbeat: false });
    for (const char of "NO_REPLY") {
      await signaler.signalTextDelta(char);
    }
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("does not start typing for NO_REPLY prefix characters", async () => {
    const signaler = createTypingSignaler({ typing, mode: "deferred", isHeartbeat: false });
    await signaler.signalTextDelta("N");
    await signaler.signalTextDelta("O");
    await signaler.signalTextDelta("_");
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("starts typing once text diverges from NO_REPLY", async () => {
    const signaler = createTypingSignaler({ typing, mode: "deferred", isHeartbeat: false });
    await signaler.signalTextDelta("H");
    expect(typing.startTypingOnText).toHaveBeenCalledWith("H");
  });

  it("starts typing when text clearly not NO_REPLY after partial match", async () => {
    const signaler = createTypingSignaler({ typing, mode: "deferred", isHeartbeat: false });
    await signaler.signalTextDelta("N");
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    await signaler.signalTextDelta("o"); // lowercase 'o' — diverges from "NO_REPLY"
    expect(typing.startTypingOnText).toHaveBeenCalledWith("o");
  });

  it("starts typing on tool start (confirms real work)", async () => {
    const signaler = createTypingSignaler({ typing, mode: "deferred", isHeartbeat: false });
    await signaler.signalToolStart();
    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("behaves like message mode after confirmed real reply", async () => {
    const signaler = createTypingSignaler({ typing, mode: "deferred", isHeartbeat: false });
    // First delta diverges from NO_REPLY
    await signaler.signalTextDelta("Hello");
    expect(typing.startTypingOnText).toHaveBeenCalledWith("Hello");

    // Subsequent deltas should pass through normally
    vi.mocked(typing.startTypingOnText).mockClear();
    await signaler.signalTextDelta(" world");
    expect(typing.startTypingOnText).toHaveBeenCalledWith(" world");
  });

  it("does not start typing on message start without confirmed text", async () => {
    const signaler = createTypingSignaler({ typing, mode: "deferred", isHeartbeat: false });
    await signaler.signalMessageStart();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });
});
