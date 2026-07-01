// Covers the poll_vote_echo suppression: normalization must be tight enough to
// only drop an exact restatement of a just-cast vote, and the record/consume
// state must be per-session, single-shot, and TTL-bounded.
import { describe, expect, it, vi } from "vitest";
import {
  consumePollVoteEcho,
  normalizePollEchoText,
  recordPollVoteForEchoGuard,
} from "./message-tool.js";

describe("normalizePollEchoText", () => {
  it("strips a leading emoji prefix and trailing sentence punctuation", () => {
    expect(normalizePollEchoText("🦞 Blue.")).toBe("blue");
    expect(normalizePollEchoText("Blue")).toBe("blue");
    expect(normalizePollEchoText("Blue!")).toBe("blue");
  });

  it("keeps internal/label punctuation so distinct options stay distinct", () => {
    // Codex finding: over-aggressive stripping collapsed these.
    expect(normalizePollEchoText("C#")).toBe("c#");
    expect(normalizePollEchoText("C++")).toBe("c++");
    expect(normalizePollEchoText("Node.js")).toBe("node.js");
    expect(normalizePollEchoText("C#")).not.toBe(normalizePollEchoText("C"));
  });

  it("preserves an emoji-only label instead of collapsing it to empty", () => {
    expect(normalizePollEchoText("🍎")).not.toBe("");
    expect(normalizePollEchoText("🍎")).not.toBe(normalizePollEchoText("🍊"));
  });
});

describe("poll vote echo guard", () => {
  const session = () => `test-session-${Math.random().toString(36).slice(2)}`;
  const chat = "iMessage;-;+15550001111";

  it("suppresses an exact restatement in the same chat once, then stops", () => {
    const s = session();
    recordPollVoteForEchoGuard(s, "Blue", chat);
    expect(consumePollVoteEcho(s, "🦞 Blue.", chat)).toBe(true);
    // Consumed — a second identical send is not suppressed.
    expect(consumePollVoteEcho(s, "Blue", chat)).toBe(false);
  });

  it("passes through text that adds any content", () => {
    const s = session();
    recordPollVoteForEchoGuard(s, "Blue", chat);
    expect(consumePollVoteEcho(s, "Blue, it matches our theme", chat)).toBe(false);
  });

  it("does not cross sessions", () => {
    const a = session();
    const b = session();
    recordPollVoteForEchoGuard(a, "Blue", chat);
    expect(consumePollVoteEcho(b, "Blue", chat)).toBe(false);
    expect(consumePollVoteEcho(a, "Blue", chat)).toBe(true);
  });

  it("does not suppress a matching send to a different chat", () => {
    const s = session();
    recordPollVoteForEchoGuard(s, "Blue", chat);
    // Same session, same text, but a different conversation — must not suppress.
    expect(consumePollVoteEcho(s, "Blue", "iMessage;-;+15559998888")).toBe(false);
    // The record survives, so the real echo in the original chat still drops.
    expect(consumePollVoteEcho(s, "Blue", chat)).toBe(true);
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    try {
      const s = session();
      recordPollVoteForEchoGuard(s, "Blue", chat);
      vi.advanceTimersByTime(31_000);
      expect(consumePollVoteEcho(s, "Blue", chat)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never suppresses when there is no recorded vote", () => {
    expect(consumePollVoteEcho(session(), "Blue", chat)).toBe(false);
    expect(consumePollVoteEcho(undefined, "Blue", chat)).toBe(false);
  });
});
