import { afterEach, describe, expect, it, vi } from "vitest";
import { SentMessageCache } from "./sent-message-cache.js";

describe("SentMessageCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("remembers and matches sent text", () => {
    const cache = new SentMessageCache();
    cache.remember("scope-a", { text: "hello world" });
    expect(cache.has("scope-a", { text: "hello world" })).toBe(true);
  });

  it("does not match text from a different scope", () => {
    const cache = new SentMessageCache();
    cache.remember("scope-a", { text: "hello" });
    expect(cache.has("scope-b", { text: "hello" })).toBe(false);
  });

  it("removes entry after one-shot match", () => {
    const cache = new SentMessageCache();
    cache.remember("s", { text: "text" });
    expect(cache.has("s", { text: "text" })).toBe(true);
    // Same text again should NOT match — one-shot removal.
    expect(cache.has("s", { text: "text" })).toBe(false);
  });

  it("allows user to send same text after echo is consumed", () => {
    const cache = new SentMessageCache();
    cache.remember("s", { text: "hi" });
    // Echo arrives and is consumed.
    expect(cache.has("s", { text: "hi" })).toBe(true);
    // User later sends the exact same text — should not be falsely flagged.
    expect(cache.has("s", { text: "hi" })).toBe(false);
  });

  it("trims whitespace when remembering and checking", () => {
    const cache = new SentMessageCache();
    cache.remember("s", { text: "  hello  " });
    expect(cache.has("s", { text: "hello" })).toBe(true);
  });

  it("ignores empty or whitespace-only text", () => {
    const cache = new SentMessageCache();
    cache.remember("s", { text: "" });
    cache.remember("s", { text: "   " });
    expect(cache.has("s", { text: "" })).toBe(false);
    expect(cache.has("s", { text: "   " })).toBe(false);
  });

  it("does not duplicate entries when remembering same text twice", () => {
    const cache = new SentMessageCache();
    cache.remember("s", { text: "dup" });
    cache.remember("s", { text: "dup" });
    // Should still match once.
    expect(cache.has("s", { text: "dup" })).toBe(true);
    expect(cache.has("s", { text: "dup" })).toBe(false);
  });

  it("evicts oldest entries when exceeding maxEntries", () => {
    const cache = new SentMessageCache(3);
    cache.remember("s", { text: "a" });
    cache.remember("s", { text: "b" });
    cache.remember("s", { text: "c" });
    cache.remember("s", { text: "d" }); // evicts "a"
    expect(cache.has("s", { text: "a" })).toBe(false);
    expect(cache.has("s", { text: "b" })).toBe(true);
    expect(cache.has("s", { text: "d" })).toBe(true);
  });

  it("matches regardless of elapsed time (no TTL dependency)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = new SentMessageCache();
    cache.remember("s", { text: "persistent" });
    vi.advanceTimersByTime(30_000);
    expect(cache.has("s", { text: "persistent" })).toBe(true);
  });

  it("catches bot echo without is_from_me (replaces is_from_me check)", () => {
    const cache = new SentMessageCache();
    // Bot sends reply — deliverReplies calls remember().
    cache.remember("default:chat_id:42", { text: "안녕하세요! 무엇을 도와드릴까요?" });
    // Same text echoes back via bridge (is_from_me may be null).
    expect(cache.has("default:chat_id:42", { text: "안녕하세요! 무엇을 도와드릴까요?" })).toBe(
      true,
    );
    // Real user message is not in cache — passes through.
    expect(cache.has("default:chat_id:42", { text: "오늘 날씨 어때?" })).toBe(false);
  });

  it("stores hashes, not raw text", () => {
    const cache = new SentMessageCache();
    cache.remember("s", { text: "secret message" });
    // Internal state should contain a hash, not the original text.
    const entries = (cache as unknown as { textEntries: string[] }).textEntries;
    expect(entries.length).toBe(1);
    expect(entries[0]).not.toContain("secret message");
  });

  it("matches by messageId and is not one-shot", () => {
    const cache = new SentMessageCache();
    cache.remember("s", { messageId: "msg-abc" });
    expect(cache.has("s", { messageId: "msg-abc" })).toBe(true);
    // messageId is NOT one-shot — same message can echo multiple times.
    expect(cache.has("s", { messageId: "msg-abc" })).toBe(true);
  });

  it("does not match messageId from a different scope", () => {
    const cache = new SentMessageCache();
    cache.remember("scope-a", { messageId: "msg-1" });
    expect(cache.has("scope-b", { messageId: "msg-1" })).toBe(false);
  });

  it("ignores sentinel messageId values", () => {
    const cache = new SentMessageCache();
    cache.remember("s", { messageId: "ok" });
    cache.remember("s", { messageId: "unknown" });
    expect(cache.has("s", { messageId: "ok" })).toBe(false);
    expect(cache.has("s", { messageId: "unknown" })).toBe(false);
  });

  it("text persists beyond 5s — no TTL expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = new SentMessageCache();
    cache.remember("acct:imessage:+1555", { text: "hello", messageId: "m-1" });
    vi.advanceTimersByTime(6000);
    // Text hash has no TTL — still matches after 6s.
    expect(cache.has("acct:imessage:+1555", { text: "hello" })).toBe(true);
    // MessageId also still matches within 60s window.
    expect(cache.has("acct:imessage:+1555", { messageId: "m-1" })).toBe(true);
  });
});
