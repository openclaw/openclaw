import { describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    MessageThreadId: undefined,
    TransportThreadId: undefined,
    ...overrides,
  } as MsgContext;
}

describe("resolveRoutedDeliveryThreadId", () => {
  // ── Priority 1: MessageThreadId ──
  it("returns MessageThreadId when present", () => {
    const ctx = makeCtx({ MessageThreadId: "msg-thread-1" });
    expect(resolveRoutedDeliveryThreadId({ ctx })).toBe("msg-thread-1");
  });

  it("returns MessageThreadId even when deliveryThreadId is also provided", () => {
    const ctx = makeCtx({ MessageThreadId: 42 });
    expect(resolveRoutedDeliveryThreadId({ ctx, deliveryThreadId: "delivery-thread" })).toBe(42);
  });

  // ── Priority 2: TransportThreadId ──
  it("returns TransportThreadId when MessageThreadId is absent", () => {
    const ctx = makeCtx({ TransportThreadId: "transport-thread-2" });
    expect(resolveRoutedDeliveryThreadId({ ctx })).toBe("transport-thread-2");
  });

  it("returns TransportThreadId over deliveryThreadId", () => {
    const ctx = makeCtx({ TransportThreadId: "transport-thread" });
    expect(resolveRoutedDeliveryThreadId({ ctx, deliveryThreadId: "delivery-thread" })).toBe(
      "transport-thread",
    );
  });

  // ── Priority 3: deliveryThreadId (NEW, #97633) ──
  it("falls back to deliveryThreadId when MessageThreadId and TransportThreadId are absent (string)", () => {
    const ctx = makeCtx();
    expect(resolveRoutedDeliveryThreadId({ ctx, deliveryThreadId: "delivery-thread-3" })).toBe(
      "delivery-thread-3",
    );
  });

  it("falls back to deliveryThreadId when MessageThreadId and TransportThreadId are absent (number)", () => {
    const ctx = makeCtx();
    expect(resolveRoutedDeliveryThreadId({ ctx, deliveryThreadId: 12345 })).toBe(12345);
  });

  it("deliveryThreadId with value 0 is treated as present (number 0 is valid)", () => {
    const ctx = makeCtx();
    // Thread id 0 is valid in some systems
    expect(resolveRoutedDeliveryThreadId({ ctx, deliveryThreadId: 0 })).toBe(0);
  });

  // ── Priority 4: session key parse ──
  it("parses thread id from session key when deliveryThreadId is absent", () => {
    const ctx = makeCtx();
    const result = resolveRoutedDeliveryThreadId({
      ctx,
      sessionKey: "agent:user:thread:789",
    });
    expect(result).toBe("789");
  });

  it("parses thread id from ACP-style session key (no :thread: suffix)", () => {
    const ctx = makeCtx();
    // ACP session keys use agent:<id>:acp:<uuid> — no :thread: suffix,
    // so parseSessionThreadInfoFast can't find a threadId.
    const result = resolveRoutedDeliveryThreadId({
      ctx,
      sessionKey: "agent:42:acp:abc-123",
    });
    // Without deliveryThreadId, ACP keys return undefined from parse
    expect(result).toBeUndefined();
  });

  it("deliveryThreadId bridges ACP key gap", () => {
    const ctx = makeCtx();
    // This is the exact scenario #97633 fixes:
    // ACP session key has no :thread: suffix, but deliveryContext.threadId is set.
    const result = resolveRoutedDeliveryThreadId({
      ctx,
      sessionKey: "agent:42:acp:abc-123",
      deliveryThreadId: "acp-thread-999",
    });
    expect(result).toBe("acp-thread-999");
  });

  // ── Edge cases ──
  it("returns undefined when all sources are absent", () => {
    const ctx = makeCtx();
    expect(resolveRoutedDeliveryThreadId({ ctx, sessionKey: "agent:42:main" })).toBeUndefined();
  });

  it("deliveryThreadId is skipped when null", () => {
    const ctx = makeCtx();
    const result = resolveRoutedDeliveryThreadId({
      ctx,
      sessionKey: "agent:user:thread:555",
      deliveryThreadId: null as unknown as undefined,
    });
    // null is not != null, so falls through to parseSessionThreadInfoFast
    expect(result).toBe("555");
  });
});
