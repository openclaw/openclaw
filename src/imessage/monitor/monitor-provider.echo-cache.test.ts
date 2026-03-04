import { afterEach, describe, expect, it, vi } from "vitest";
import { SentMessageCache } from "./sent-message-cache.js";

describe("iMessage sent-message echo cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches recent text within the same scope", () => {
    const cache = new SentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "  Reasoning:\r\n_step_  " });

    expect(cache.has("acct:imessage:+1555", { text: "Reasoning:\n_step_" })).toBe(true);
    expect(cache.has("acct:imessage:+1666", { text: "Reasoning:\n_step_" })).toBe(false);
  });

  it("matches by outbound message id and ignores placeholder ids", () => {
    const cache = new SentMessageCache();

    cache.remember("acct:imessage:+1555", { messageId: "abc-123" });
    cache.remember("acct:imessage:+1555", { messageId: "ok" });

    expect(cache.has("acct:imessage:+1555", { messageId: "abc-123" })).toBe(true);
    expect(cache.has("acct:imessage:+1555", { messageId: "ok" })).toBe(false);
  });

  it("text persists beyond 5s (no TTL) while message-id also matches within 60s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = new SentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "hello", messageId: "m-1" });
    vi.advanceTimersByTime(6000);

    // Text hash has no TTL — still matches after 6s (unlike the old 5s TTL approach).
    expect(cache.has("acct:imessage:+1555", { text: "hello" })).toBe(true);
    // MessageId also still matches within the 60s window.
    expect(cache.has("acct:imessage:+1555", { messageId: "m-1" })).toBe(true);
  });
});
