import { describe, it, expect, vi } from "vitest";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

function stubTyping(): TypingController {
  let active = false;
  return {
    onReplyStart: vi.fn(),
    startTypingLoop: vi.fn(async () => {
      active = true;
    }),
    startTypingOnText: vi.fn(async () => {
      active = true;
    }),
    refreshTypingTtl: vi.fn(),
    isActive: () => active,
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
  };
}

describe("signalToolStart guards for NO_REPLY runs (#33951)", () => {
  it("does not start typing on tool execution in message mode before renderable text", async () => {
    const typing = stubTyping();
    const signaler = createTypingSignaler({ typing, mode: "message", isHeartbeat: false });

    // Tool starts but no text has been seen yet — should NOT trigger typing.
    await signaler.signalToolStart();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.refreshTypingTtl).not.toHaveBeenCalled();
  });

  it("starts typing on tool execution in message mode AFTER renderable text", async () => {
    const typing = stubTyping();
    const signaler = createTypingSignaler({ typing, mode: "message", isHeartbeat: false });

    // Simulate renderable text arriving first.
    await signaler.signalTextDelta("Hello");

    // Reset to check tool-start specifically.
    vi.mocked(typing.startTypingLoop).mockClear();

    // Tool starts after text — typing should start.
    await signaler.signalToolStart();

    // Typing was already started by text delta, so signalToolStart
    // should only refresh TTL (typing.isActive() === true).
    expect(typing.refreshTypingTtl).toHaveBeenCalled();
  });

  it("starts typing on tool execution in instant mode without prior text", async () => {
    const typing = stubTyping();
    const signaler = createTypingSignaler({ typing, mode: "instant", isHeartbeat: false });

    // In instant mode, typing starts at run start, but if not active
    // yet, tool start should still trigger it.
    await signaler.signalToolStart();

    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("starts typing on tool execution in thinking mode without prior text", async () => {
    const typing = stubTyping();
    const signaler = createTypingSignaler({ typing, mode: "thinking", isHeartbeat: false });

    // In thinking mode, tool start should trigger typing even without text.
    await signaler.signalToolStart();

    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("never starts typing on tool execution when mode is never", async () => {
    const typing = stubTyping();
    const signaler = createTypingSignaler({ typing, mode: "never", isHeartbeat: false });

    await signaler.signalToolStart();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("never starts typing when isHeartbeat is true", async () => {
    const typing = stubTyping();
    const signaler = createTypingSignaler({ typing, mode: "message", isHeartbeat: true });

    await signaler.signalToolStart();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("does not start typing on tool execution in message mode with only silent text", async () => {
    const typing = stubTyping();
    const signaler = createTypingSignaler({ typing, mode: "message", isHeartbeat: false });

    // Send the silent reply token — should NOT set hasRenderableText.
    await signaler.signalTextDelta("NO_REPLY");

    await signaler.signalToolStart();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });
});
