import { describe, expect, it } from "vitest";
import { parseDeliveryContextFromParams } from "./restart-request.js";

// ─────────────────────────────────────────────────────────────────────────────
// parseDeliveryContextFromParams
// Validates that only complete, routable delivery contexts are accepted
// and that partial or malformed inputs are rejected.
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDeliveryContextFromParams", () => {
  // ── No context present ────────────────────────────────────────────────────

  it("returns undefined when deliveryContext is absent", () => {
    expect(parseDeliveryContextFromParams({})).toBeUndefined();
  });

  it("returns undefined when deliveryContext is null", () => {
    expect(parseDeliveryContextFromParams({ deliveryContext: null })).toBeUndefined();
  });

  it("returns undefined when deliveryContext is a non-object (string)", () => {
    expect(parseDeliveryContextFromParams({ deliveryContext: "discord" })).toBeUndefined();
  });

  it("returns undefined when deliveryContext is a non-object (number)", () => {
    expect(parseDeliveryContextFromParams({ deliveryContext: 42 })).toBeUndefined();
  });

  // ── Partial context — must be rejected (prevents routing ambiguity) ───────

  it("returns undefined when both channel and to are absent", () => {
    expect(parseDeliveryContextFromParams({ deliveryContext: {} })).toBeUndefined();
  });

  it("returns undefined when only channel is present (partial context)", () => {
    expect(
      parseDeliveryContextFromParams({ deliveryContext: { channel: "discord" } }),
    ).toBeUndefined();
  });

  it("returns undefined when only to is present (partial context)", () => {
    expect(
      parseDeliveryContextFromParams({ deliveryContext: { to: "123456789" } }),
    ).toBeUndefined();
  });

  it("returns undefined when channel is present but to is an empty string", () => {
    expect(
      parseDeliveryContextFromParams({ deliveryContext: { channel: "discord", to: "" } }),
    ).toBeUndefined();
  });

  it("returns undefined when to is present but channel is an empty string", () => {
    expect(
      parseDeliveryContextFromParams({ deliveryContext: { channel: "", to: "123456789" } }),
    ).toBeUndefined();
  });

  it("returns undefined when channel is whitespace-only", () => {
    expect(
      parseDeliveryContextFromParams({ deliveryContext: { channel: "   ", to: "123456789" } }),
    ).toBeUndefined();
  });

  it("returns undefined when to is whitespace-only", () => {
    expect(
      parseDeliveryContextFromParams({ deliveryContext: { channel: "discord", to: "   " } }),
    ).toBeUndefined();
  });

  // ── Non-string field types ────────────────────────────────────────────────

  it("returns undefined when channel is a number (type coercion not allowed)", () => {
    expect(
      parseDeliveryContextFromParams({ deliveryContext: { channel: 42, to: "123" } }),
    ).toBeUndefined();
  });

  it("returns undefined when to is a boolean", () => {
    expect(
      parseDeliveryContextFromParams({ deliveryContext: { channel: "discord", to: true } }),
    ).toBeUndefined();
  });

  // ── Complete context ──────────────────────────────────────────────────────

  it("returns full context when both channel and to are present", () => {
    expect(
      parseDeliveryContextFromParams({
        deliveryContext: { channel: "discord", to: "123456789" },
      }),
    ).toEqual({ channel: "discord", to: "123456789", accountId: undefined, threadId: undefined });
  });

  it("includes accountId when present", () => {
    const result = parseDeliveryContextFromParams({
      deliveryContext: { channel: "discord", to: "123456789", accountId: "acct-1" },
    });
    expect(result?.accountId).toBe("acct-1");
  });

  it("includes threadId when present", () => {
    const result = parseDeliveryContextFromParams({
      deliveryContext: { channel: "slack", to: "C012AB3CD", threadId: "1234567890.123456" },
    });
    expect(result?.threadId).toBe("1234567890.123456");
  });

  it("includes all four fields when all are present", () => {
    expect(
      parseDeliveryContextFromParams({
        deliveryContext: {
          channel: "slack",
          to: "C012AB3CD",
          accountId: "acct-1",
          threadId: "1234567890.123456",
        },
      }),
    ).toEqual({
      channel: "slack",
      to: "C012AB3CD",
      accountId: "acct-1",
      threadId: "1234567890.123456",
    });
  });

  // ── Whitespace trimming ───────────────────────────────────────────────────

  it("trims leading/trailing whitespace from channel", () => {
    const result = parseDeliveryContextFromParams({
      deliveryContext: { channel: "  discord  ", to: "123456789" },
    });
    expect(result?.channel).toBe("discord");
  });

  it("trims leading/trailing whitespace from to", () => {
    const result = parseDeliveryContextFromParams({
      deliveryContext: { channel: "discord", to: "  123456789  " },
    });
    expect(result?.to).toBe("123456789");
  });

  it("trims leading/trailing whitespace from threadId", () => {
    const result = parseDeliveryContextFromParams({
      deliveryContext: { channel: "discord", to: "123", threadId: "  ts.1  " },
    });
    expect(result?.threadId).toBe("ts.1");
  });

  it("trims all string fields simultaneously", () => {
    expect(
      parseDeliveryContextFromParams({
        deliveryContext: {
          channel: "  discord  ",
          to: "  123  ",
          accountId: "  acct  ",
          threadId: "  ts.1  ",
        },
      }),
    ).toEqual({ channel: "discord", to: "123", accountId: "acct", threadId: "ts.1" });
  });

  // ── Optional fields absent / undefined ───────────────────────────────────

  it("returns undefined for accountId when not provided", () => {
    const result = parseDeliveryContextFromParams({
      deliveryContext: { channel: "discord", to: "123456789" },
    });
    expect(result?.accountId).toBeUndefined();
  });

  it("returns undefined for threadId when not provided", () => {
    const result = parseDeliveryContextFromParams({
      deliveryContext: { channel: "discord", to: "123456789" },
    });
    expect(result?.threadId).toBeUndefined();
  });

  it("returns undefined for accountId when value is empty string after trim", () => {
    const result = parseDeliveryContextFromParams({
      deliveryContext: { channel: "discord", to: "123456789", accountId: "  " },
    });
    expect(result?.accountId).toBeUndefined();
  });

  it("returns undefined for threadId when value is empty string after trim", () => {
    const result = parseDeliveryContextFromParams({
      deliveryContext: { channel: "discord", to: "123456789", threadId: "  " },
    });
    expect(result?.threadId).toBeUndefined();
  });

  // ── Extra/unknown fields are ignored ─────────────────────────────────────

  it("ignores unknown extra fields in deliveryContext", () => {
    const result = parseDeliveryContextFromParams({
      deliveryContext: { channel: "discord", to: "123456789", unknownField: "ignored" },
    });
    expect(result).toEqual({
      channel: "discord",
      to: "123456789",
      accountId: undefined,
      threadId: undefined,
    });
    expect((result as Record<string, unknown>)?.unknownField).toBeUndefined();
  });
});
