import { describe, expect, it } from "vitest";
import { parseDeliveryContextFromParams } from "./restart-request.js";

describe("parseDeliveryContextFromParams", () => {
  it("returns undefined when deliveryContext is absent", () => {
    expect(parseDeliveryContextFromParams({})).toBeUndefined();
  });

  it("returns undefined when both channel and to are missing", () => {
    expect(parseDeliveryContextFromParams({ deliveryContext: {} })).toBeUndefined();
  });

  it("returns undefined when only channel is present (partial context rejected)", () => {
    expect(
      parseDeliveryContextFromParams({ deliveryContext: { channel: "discord" } }),
    ).toBeUndefined();
  });

  it("returns undefined when only to is present (partial context rejected)", () => {
    expect(
      parseDeliveryContextFromParams({ deliveryContext: { to: "123456789" } }),
    ).toBeUndefined();
  });

  it("returns full context when both channel and to are present", () => {
    expect(
      parseDeliveryContextFromParams({
        deliveryContext: { channel: "discord", to: "123456789" },
      }),
    ).toEqual({ channel: "discord", to: "123456789", accountId: undefined, threadId: undefined });
  });

  it("includes accountId and threadId when present", () => {
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

  it("trims whitespace from all string fields", () => {
    expect(
      parseDeliveryContextFromParams({
        deliveryContext: { channel: "  discord  ", to: "  123  ", threadId: "  ts.1  " },
      }),
    ).toEqual({ channel: "discord", to: "123", accountId: undefined, threadId: "ts.1" });
  });
});
