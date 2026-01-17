import { describe, expect, it } from "vitest";

import {
  deliveryContextKey,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
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
    expect(deliveryContextKey({ channel: "whatsapp", to: "+1555" })).toBe("whatsapp|+1555|");
    expect(deliveryContextKey({ channel: "whatsapp" })).toBeUndefined();
    expect(deliveryContextKey({ channel: "whatsapp", to: "+1555", accountId: "acct-1" })).toBe(
      "whatsapp|+1555|acct-1",
    );
  });

  it("derives delivery context from a session entry", () => {
    expect(
      deliveryContextFromSession({
        channel: "webchat",
        lastChannel: " whatsapp ",
        lastTo: " +1777 ",
        lastAccountId: " acct-9 ",
      }),
    ).toEqual({
      channel: "whatsapp",
      to: "+1777",
      accountId: "acct-9",
    });

    expect(
      deliveryContextFromSession({
        channel: "telegram",
        lastTo: " 123 ",
      }),
    ).toEqual({
      channel: "telegram",
      to: "123",
      accountId: undefined,
    });
  });

  it("normalizes delivery fields and mirrors them on session entries", () => {
    const normalized = normalizeSessionDeliveryFields({
      deliveryContext: { channel: " Slack ", to: " channel:1 ", accountId: " acct-2 " },
      lastChannel: " whatsapp ",
      lastTo: " +1555 ",
    });

    expect(normalized.deliveryContext).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: "acct-2",
    });
    expect(normalized.lastChannel).toBe("whatsapp");
    expect(normalized.lastTo).toBe("+1555");
    expect(normalized.lastAccountId).toBe("acct-2");
  });
});
