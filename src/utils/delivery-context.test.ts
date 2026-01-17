import { describe, expect, it } from "vitest";

import {
  deliveryContextKey,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "./delivery-context.js";

describe("delivery context helpers", () => {
  it("normalizes channel/to/accountId and drops empty contexts", () => {
    expect(
      normalizeDeliveryContext({
        channel: " whatsapp ",
        to: " +1555 ",
        accountId: " acct-1 ",
      }),
    ).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: "acct-1",
    });

    expect(normalizeDeliveryContext({ channel: "  " })).toBeUndefined();
  });

  it("merges primary values over fallback", () => {
    const merged = mergeDeliveryContext(
      { channel: "whatsapp", to: "channel:abc" },
      { channel: "slack", to: "channel:def", accountId: "acct" },
    );

    expect(merged).toEqual({
      channel: "whatsapp",
      to: "channel:abc",
      accountId: "acct",
    });
  });

  it("builds stable keys only when channel and to are present", () => {
    expect(deliveryContextKey({ channel: "whatsapp", to: "+1555" })).toBe(
      "whatsapp|+1555|",
    );
    expect(deliveryContextKey({ channel: "whatsapp" })).toBeUndefined();
  });
});
