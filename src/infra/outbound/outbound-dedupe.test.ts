import { afterEach, describe, expect, it } from "vitest";
import {
  buildOutboundDedupeKey,
  isOutboundDuplicate,
  registerOutboundDelivered,
  resetOutboundDedupe,
} from "./outbound-dedupe.js";
import type { OutboundDedupeKeyParams } from "./outbound-dedupe.js";

function makeParams(overrides?: Partial<OutboundDedupeKeyParams>): OutboundDedupeKeyParams {
  return {
    channel: "telegram",
    to: "123",
    payload: { text: "Hello, world!" },
    ...overrides,
  };
}

describe("buildOutboundDedupeKey", () => {
  it("returns null for empty payload", () => {
    expect(buildOutboundDedupeKey(makeParams({ payload: {} }))).toBeNull();
    expect(buildOutboundDedupeKey(makeParams({ payload: { text: "  " } }))).toBeNull();
    expect(buildOutboundDedupeKey(makeParams({ payload: { text: "" } }))).toBeNull();
  });

  it("normalizes text for comparison", () => {
    const key1 = buildOutboundDedupeKey(makeParams({ payload: { text: "Hello, world!" } }));
    const key2 = buildOutboundDedupeKey(makeParams({ payload: { text: "  hello,  world!  " } }));
    expect(key1).toBe(key2);
  });

  it("includes channel and to in the key", () => {
    const key1 = buildOutboundDedupeKey(makeParams({ channel: "telegram" }));
    const key2 = buildOutboundDedupeKey(makeParams({ channel: "whatsapp" }));
    expect(key1).not.toBe(key2);
  });

  it("includes accountId in the key", () => {
    const key1 = buildOutboundDedupeKey(makeParams({ accountId: "acc1" }));
    const key2 = buildOutboundDedupeKey(makeParams({ accountId: "acc2" }));
    expect(key1).not.toBe(key2);
  });

  it("includes threadId in the key", () => {
    const key1 = buildOutboundDedupeKey(makeParams({ threadId: "t1" }));
    const key2 = buildOutboundDedupeKey(makeParams({ threadId: "t2" }));
    expect(key1).not.toBe(key2);
  });

  it("excludes audioAsVoice from the key", () => {
    const key1 = buildOutboundDedupeKey(
      makeParams({ payload: { text: "hi", audioAsVoice: true } }),
    );
    const key2 = buildOutboundDedupeKey(
      makeParams({ payload: { text: "hi", audioAsVoice: false } }),
    );
    expect(key1).toBe(key2);
  });

  it("sorts media URLs for stable key", () => {
    const key1 = buildOutboundDedupeKey(
      makeParams({ payload: { text: "hi", mediaUrls: ["b.jpg", "a.jpg"] } }),
    );
    const key2 = buildOutboundDedupeKey(
      makeParams({ payload: { text: "hi", mediaUrls: ["a.jpg", "b.jpg"] } }),
    );
    expect(key1).toBe(key2);
  });

  it("returns non-null for channelData-only payload", () => {
    const key = buildOutboundDedupeKey(makeParams({ payload: { channelData: { mode: "flex" } } }));
    expect(key).not.toBeNull();
  });

  it("differentiates distinct channelData payloads", () => {
    const key1 = buildOutboundDedupeKey(
      makeParams({ payload: { channelData: { mode: "flex", layout: "carousel" } } }),
    );
    const key2 = buildOutboundDedupeKey(
      makeParams({ payload: { channelData: { mode: "flex", layout: "list" } } }),
    );
    expect(key1).not.toBe(key2);
  });

  it("produces same key for identical channelData regardless of insertion order", () => {
    const key1 = buildOutboundDedupeKey(makeParams({ payload: { channelData: { a: 1, b: 2 } } }));
    const key2 = buildOutboundDedupeKey(makeParams({ payload: { channelData: { b: 2, a: 1 } } }));
    expect(key1).toBe(key2);
  });

  it("includes replyToId in the key", () => {
    const key1 = buildOutboundDedupeKey(makeParams({ payload: { text: "hi", replyToId: "1" } }));
    const key2 = buildOutboundDedupeKey(makeParams({ payload: { text: "hi", replyToId: "2" } }));
    expect(key1).not.toBe(key2);
  });

  it("uses resolvedReplyToId when payload.replyToId is unset", () => {
    const key1 = buildOutboundDedupeKey(
      makeParams({ resolvedReplyToId: "r1", payload: { text: "hi" } }),
    );
    const key2 = buildOutboundDedupeKey(
      makeParams({ resolvedReplyToId: "r2", payload: { text: "hi" } }),
    );
    expect(key1).not.toBe(key2);
  });

  it("payload.replyToId takes precedence over resolvedReplyToId", () => {
    const key1 = buildOutboundDedupeKey(
      makeParams({ resolvedReplyToId: "r1", payload: { text: "hi", replyToId: "p1" } }),
    );
    const key2 = buildOutboundDedupeKey(
      makeParams({ resolvedReplyToId: "r2", payload: { text: "hi", replyToId: "p1" } }),
    );
    expect(key1).toBe(key2);
  });

  it("handles field values containing special characters without collision", () => {
    // Ensure JSON serialization prevents delimiter-based collisions
    const key1 = buildOutboundDedupeKey(
      makeParams({ to: "a|b", threadId: "", payload: { text: "hi" } }),
    );
    const key2 = buildOutboundDedupeKey(
      makeParams({ to: "a", threadId: "b", payload: { text: "hi" } }),
    );
    expect(key1).not.toBe(key2);
  });

  it("uses mediaUrl when mediaUrls is not set", () => {
    const key1 = buildOutboundDedupeKey(makeParams({ payload: { text: "hi", mediaUrl: "a.jpg" } }));
    const key2 = buildOutboundDedupeKey(
      makeParams({ payload: { text: "hi", mediaUrls: ["a.jpg"] } }),
    );
    expect(key1).toBe(key2);
  });
});

describe("isOutboundDuplicate / registerOutboundDelivered", () => {
  afterEach(() => {
    resetOutboundDedupe();
  });

  it("returns false on first encounter", () => {
    expect(isOutboundDuplicate(makeParams())).toBe(false);
  });

  it("returns true after registration within TTL", () => {
    const now = Date.now();
    registerOutboundDelivered(makeParams(), now);
    expect(isOutboundDuplicate(makeParams(), now + 100)).toBe(true);
  });

  it("returns false after TTL expires", () => {
    const now = Date.now();
    registerOutboundDelivered(makeParams(), now);
    // TTL is 30s, check at 31s
    expect(isOutboundDuplicate(makeParams(), now + 31_000)).toBe(false);
  });

  it("returns false for different recipient", () => {
    const now = Date.now();
    registerOutboundDelivered(makeParams({ to: "123" }), now);
    expect(isOutboundDuplicate(makeParams({ to: "456" }), now + 100)).toBe(false);
  });

  it("returns false for different channel", () => {
    const now = Date.now();
    registerOutboundDelivered(makeParams({ channel: "telegram" }), now);
    expect(isOutboundDuplicate(makeParams({ channel: "whatsapp" }), now + 100)).toBe(false);
  });

  it("does not register on peek (isOutboundDuplicate)", () => {
    const now = Date.now();
    // Peek only — should not register
    isOutboundDuplicate(makeParams(), now);
    // Should still be false since peek doesn't register
    expect(isOutboundDuplicate(makeParams(), now + 100)).toBe(false);
  });

  it("handles empty payload gracefully", () => {
    expect(isOutboundDuplicate(makeParams({ payload: {} }))).toBe(false);
    // Should not throw
    registerOutboundDelivered(makeParams({ payload: {} }));
  });
});
