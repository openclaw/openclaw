// Transcript event tests cover transcript event parsing and compaction.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitInternalSessionTranscriptUpdate,
  emitSessionTranscriptUpdate,
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
} from "./transcript-events.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
});

describe("transcript events", () => {
  it("emits trimmed archive file updates", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({ sessionFile: "  /tmp/session.jsonl  " });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ sessionFile: "/tmp/session.jsonl" });
  });

  it("includes optional session metadata when provided", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      sessionFile: "  /tmp/session.jsonl  ",
      sessionKey: "  agent:main:main  ",
      agentId: "  main  ",
      message: { role: "assistant", content: "hi" },
      messageId: "  msg-1  ",
      messageSeq: 2,
    });

    expect(listener).toHaveBeenCalledWith({
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:main",
      agentId: "main",
      message: { role: "assistant", content: "hi" },
      messageId: "msg-1",
      messageSeq: 2,
    });
  });

  it("exposes identity-only updates to public listeners", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      target: {
        agentId: " main ",
        sessionId: " sess-1 ",
        sessionKey: " agent:main:main ",
      },
      messageId: " msg-1 ",
    });

    expect(listener).toHaveBeenCalledWith({
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
      },
      agentId: "main",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      messageId: "msg-1",
    });
  });

  it("emits storage-neutral identity updates to internal listeners", () => {
    const listener = vi.fn();
    cleanup.push(onInternalSessionTranscriptUpdate(listener));

    emitInternalSessionTranscriptUpdate({
      target: {
        agentId: " main ",
        sessionId: " sess-1 ",
        sessionKey: " agent:main:main ",
      },
      messageId: " msg-1 ",
    });

    expect(listener).toHaveBeenCalledWith({
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
      },
      agentId: "main",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      messageId: "msg-1",
    });
  });

  it("derives target identity from public file updates", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
    });

    expect(listener).toHaveBeenCalledWith({
      sessionFile: "/tmp/session.jsonl",
      target: {
        agentId: "main",
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
      },
      agentId: "main",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
    });
  });

  it("keeps public global file updates on the compatibility shape", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "global",
    });

    expect(listener).toHaveBeenCalledWith({
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "global",
    });
  });

  it("drops invalid message sequence values", () => {
    const listener = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(listener));

    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/session.jsonl",
      messageSeq: 0,
    });
    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/session.jsonl",
      messageSeq: 1.5,
    });
    emitSessionTranscriptUpdate({
      sessionFile: "/tmp/session.jsonl",
      messageSeq: Number.POSITIVE_INFINITY,
    });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenNthCalledWith(1, { sessionFile: "/tmp/session.jsonl" });
    expect(listener).toHaveBeenNthCalledWith(2, { sessionFile: "/tmp/session.jsonl" });
    expect(listener).toHaveBeenNthCalledWith(3, { sessionFile: "/tmp/session.jsonl" });
  });

  it("continues notifying other listeners when one throws", () => {
    const first = vi.fn(() => {
      throw new Error("boom");
    });
    const second = vi.fn();
    cleanup.push(onSessionTranscriptUpdate(first));
    cleanup.push(onSessionTranscriptUpdate(second));

    expect(emitSessionTranscriptUpdate({ sessionFile: "/tmp/session.jsonl" })).toBeUndefined();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
