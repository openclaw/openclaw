import { afterEach, describe, expect, it } from "vitest";
import {
  buildOutboundDedupeKey,
  claimOutboundDelivery,
  isOutboundDuplicate,
  registerOutboundDelivered,
  resetOutboundDedupe,
  rollbackOutboundClaim,
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

  it("differentiates nested channelData payloads", () => {
    const key1 = buildOutboundDedupeKey(
      makeParams({
        payload: { channelData: { template: { type: "carousel", items: [1, 2, 3] } } },
      }),
    );
    const key2 = buildOutboundDedupeKey(
      makeParams({
        payload: { channelData: { template: { type: "bubble", items: [4, 5, 6] } } },
      }),
    );
    expect(key1).not.toBe(key2);
  });

  it("produces same key for identical channelData regardless of insertion order", () => {
    const key1 = buildOutboundDedupeKey(makeParams({ payload: { channelData: { a: 1, b: 2 } } }));
    const key2 = buildOutboundDedupeKey(makeParams({ payload: { channelData: { b: 2, a: 1 } } }));
    expect(key1).toBe(key2);
  });

  it("produces same key for deeply nested channelData regardless of insertion order", () => {
    const key1 = buildOutboundDedupeKey(
      makeParams({ payload: { channelData: { outer: { z: 3, a: 1 } } } }),
    );
    const key2 = buildOutboundDedupeKey(
      makeParams({ payload: { channelData: { outer: { a: 1, z: 3 } } } }),
    );
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

  it("differentiates distinct emoji-only messages", () => {
    const key1 = buildOutboundDedupeKey(makeParams({ payload: { text: "\u{1F600}" } }));
    const key2 = buildOutboundDedupeKey(makeParams({ payload: { text: "\u{1F622}" } }));
    expect(key1).not.toBe(key2);
  });

  it("returns non-null key for emoji-only text", () => {
    const key = buildOutboundDedupeKey(makeParams({ payload: { text: "\u{1F600}" } }));
    expect(key).not.toBeNull();
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
    isOutboundDuplicate(makeParams(), now);
    expect(isOutboundDuplicate(makeParams(), now + 100)).toBe(false);
  });

  it("handles empty payload gracefully", () => {
    expect(isOutboundDuplicate(makeParams({ payload: {} }))).toBe(false);
    registerOutboundDelivered(makeParams({ payload: {} }));
  });
});

describe("claimOutboundDelivery / rollbackOutboundClaim", () => {
  afterEach(() => {
    resetOutboundDedupe();
  });

  it("returns key string on first claim", () => {
    const key = claimOutboundDelivery(makeParams());
    expect(key).not.toBeNull();
    expect(typeof key).toBe("string");
  });

  it("returns null on second claim (duplicate)", () => {
    claimOutboundDelivery(makeParams());
    const second = claimOutboundDelivery(makeParams());
    expect(second).toBeNull();
  });

  it("returns null for empty payload", () => {
    const key = claimOutboundDelivery(makeParams({ payload: {} }));
    expect(key).toBeNull();
  });

  it("allows retry after rollback", () => {
    const key = claimOutboundDelivery(makeParams());
    expect(key).not.toBeNull();
    rollbackOutboundClaim(key!);
    const retry = claimOutboundDelivery(makeParams());
    expect(retry).not.toBeNull();
  });

  it("blocks concurrent claims for same payload", () => {
    const now = Date.now();
    const key1 = claimOutboundDelivery(makeParams(), now);
    const key2 = claimOutboundDelivery(makeParams(), now + 1);
    expect(key1).not.toBeNull();
    expect(key2).toBeNull();
  });

  it("allows claims for different recipients", () => {
    const key1 = claimOutboundDelivery(makeParams({ to: "123" }));
    const key2 = claimOutboundDelivery(makeParams({ to: "456" }));
    expect(key1).not.toBeNull();
    expect(key2).not.toBeNull();
  });
});
