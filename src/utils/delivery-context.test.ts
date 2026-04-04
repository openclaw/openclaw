import { describe, expect, it } from "vitest";
import {
  normalizeDeliveryContext,
  formatConversationTarget,
  mergeDeliveryContext,
  deliveryContextKey,
} from "./delivery-context.js";

describe("normalizeDeliveryContext", () => {
  it("returns undefined for empty context", () => {
    expect(normalizeDeliveryContext(undefined)).toBeUndefined();
    expect(normalizeDeliveryContext({})).toBeUndefined();
  });

  it("normalizes channel name", () => {
    const result = normalizeDeliveryContext({ channel: "Telegram" });
    expect(result?.channel).toBe("telegram");
  });

  it("normalizes thread ID as integer", () => {
    const result = normalizeDeliveryContext({ threadId: 123.9 });
    expect(result?.threadId).toBe(123);
  });

  it("trims string values", () => {
    const result = normalizeDeliveryContext({ channel: "  telegram  ", to: "  user123  " });
    expect(result?.channel).toBe("telegram");
    expect(result?.to).toBe("user123");
  });
});

describe("formatConversationTarget", () => {
  it("returns undefined for missing channel or conversationId", () => {
    expect(formatConversationTarget({})).toBeUndefined();
    expect(formatConversationTarget({ channel: "telegram" })).toBeUndefined();
  });

  it("formats non-matrix channel", () => {
    const result = formatConversationTarget({
      channel: "telegram",
      conversationId: "123",
    });
    expect(result).toBe("channel:123");
  });

  it("formats matrix channel", () => {
    const result = formatConversationTarget({
      channel: "matrix",
      conversationId: "room-456",
    });
    expect(result).toBe("room:room-456");
  });
});

describe("mergeDeliveryContext", () => {
  it("returns undefined for empty inputs", () => {
    expect(mergeDeliveryContext(undefined, undefined)).toBeUndefined();
  });

  it("prefers primary over fallback", () => {
    const result = mergeDeliveryContext(
      { channel: "telegram", to: "user1" },
      { channel: "discord", to: "user2" },
    );
    expect(result?.channel).toBe("telegram");
    expect(result?.to).toBe("user1");
  });

  it("uses fallback when primary is undefined", () => {
    const result = mergeDeliveryContext(undefined, { channel: "telegram" });
    expect(result?.channel).toBe("telegram");
  });
});

describe("deliveryContextKey", () => {
  it("returns undefined for missing channel or to", () => {
    expect(deliveryContextKey({})).toBeUndefined();
    expect(deliveryContextKey({ channel: "telegram" })).toBeUndefined();
  });

  it("formats key correctly", () => {
    const result = deliveryContextKey({ channel: "telegram", to: "user123" });
    expect(result).toBe("telegram|user123||");
  });

  it("includes threadId in key", () => {
    const result = deliveryContextKey({ channel: "telegram", to: "user123", threadId: 456 });
    expect(result).toBe("telegram|user123||456");
  });
});
