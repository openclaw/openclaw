import { describe, expect, it } from "vitest";
import { SentMessageCache } from "./sent-message-cache.js";

describe("SentMessageCache", () => {
  it("remembers and matches sent text", () => {
    const cache = new SentMessageCache();
    cache.remember("scope-a", "hello world");
    expect(cache.has("scope-a", "hello world")).toBe(true);
  });

  it("does not match text from a different scope", () => {
    const cache = new SentMessageCache();
    cache.remember("scope-a", "hello");
    expect(cache.has("scope-b", "hello")).toBe(false);
  });

  it("removes entry after one-shot match", () => {
    const cache = new SentMessageCache();
    cache.remember("s", "text");
    expect(cache.has("s", "text")).toBe(true);
    // Same text again should NOT match — one-shot removal.
    expect(cache.has("s", "text")).toBe(false);
  });

  it("allows user to send same text after echo is consumed", () => {
    const cache = new SentMessageCache();
    cache.remember("s", "hi");
    // Echo arrives and is consumed.
    expect(cache.has("s", "hi")).toBe(true);
    // User later sends the exact same text — should not be falsely flagged.
    expect(cache.has("s", "hi")).toBe(false);
  });

  it("trims whitespace when remembering and checking", () => {
    const cache = new SentMessageCache();
    cache.remember("s", "  hello  ");
    expect(cache.has("s", "hello")).toBe(true);
  });

  it("ignores empty or whitespace-only text", () => {
    const cache = new SentMessageCache();
    cache.remember("s", "");
    cache.remember("s", "   ");
    expect(cache.has("s", "")).toBe(false);
    expect(cache.has("s", "   ")).toBe(false);
  });

  it("does not duplicate entries when remembering same text twice", () => {
    const cache = new SentMessageCache();
    cache.remember("s", "dup");
    cache.remember("s", "dup");
    // Should still match once.
    expect(cache.has("s", "dup")).toBe(true);
    expect(cache.has("s", "dup")).toBe(false);
  });

  it("evicts oldest entries when exceeding maxEntries", () => {
    const cache = new SentMessageCache(3);
    cache.remember("s", "a");
    cache.remember("s", "b");
    cache.remember("s", "c");
    cache.remember("s", "d"); // evicts "a"
    expect(cache.has("s", "a")).toBe(false);
    expect(cache.has("s", "b")).toBe(true);
    expect(cache.has("s", "d")).toBe(true);
  });

  it("matches regardless of elapsed time (no TTL dependency)", () => {
    const cache = new SentMessageCache();
    cache.remember("s", "persistent");
    // No time manipulation needed — the cache has no TTL.
    expect(cache.has("s", "persistent")).toBe(true);
  });

  it("catches bot echo without is_from_me (replaces is_from_me check)", () => {
    const cache = new SentMessageCache();
    // Bot sends reply — deliverReplies calls remember().
    cache.remember("default:chat_id:42", "안녕하세요! 무엇을 도와드릴까요?");
    // Same text echoes back via bridge (is_from_me may be null).
    expect(cache.has("default:chat_id:42", "안녕하세요! 무엇을 도와드릴까요?")).toBe(true);
    // Real user message is not in cache — passes through.
    expect(cache.has("default:chat_id:42", "오늘 날씨 어때?")).toBe(false);
  });

  it("stores hashes, not raw text", () => {
    const cache = new SentMessageCache();
    cache.remember("s", "secret message");
    // Internal state should contain a hash, not the original text.
    // Access private field to verify no raw text is stored.
    const entries = (cache as unknown as { entries: string[] }).entries;
    expect(entries.length).toBe(1);
    expect(entries[0]).not.toContain("secret message");
  });
});
