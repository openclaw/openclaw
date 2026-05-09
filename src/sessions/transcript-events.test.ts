import { afterEach, describe, expect, it, vi } from "vitest";
import { emitSessionTranscriptUpdate, onSessionTranscriptUpdate } from "./transcript-events.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
});

describe("transcript events", () => {
  it("emits trimmed session-scope updates without a transcript locator", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      agentId: "  main  ",
      sessionId: "  session  ",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "session",
    });
  });

  it("includes optional session metadata when provided", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      agentId: "  main  ",
      sessionId: "  sess-1  ",
      sessionKey: "  agent:main:main  ",
      message: { role: "assistant", content: "hi" },
      messageId: "  msg-1  ",
    });

    expect(listener).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      message: { role: "assistant", content: "hi" },
      messageId: "msg-1",
    });
  });

  it("continues notifying other listeners when one throws", () => {
    const first = vi.fn(() => {
      throw new Error("boom");
    });
    const second = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(first));
    cleanup.push(onSessionTranscriptUpdate(second));

    expect(
      emitSessionTranscriptUpdate({
        agentId: "main",
        sessionId: "session",
      }),
    ).toBeUndefined();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
