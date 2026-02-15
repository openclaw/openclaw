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

  it("does not inherit route fields from fallback when channels conflict", () => {
    const merged = mergeDeliveryContext(
      { channel: "telegram" },
      { channel: "discord", to: "channel:def", accountId: "acct", threadId: "99" },
    );

    expect(merged).toEqual({
      channel: "telegram",
      to: undefined,
      accountId: undefined,
    });
    expect(merged?.threadId).toBeUndefined();
  });

  it("inherits missing route fields when channels match", () => {
    const merged = mergeDeliveryContext(
      { channel: "telegram" },
      { channel: "telegram", to: "123", accountId: "acct", threadId: "99" },
    );

    expect(merged).toEqual({
      channel: "telegram",
      to: "123",
      accountId: "acct",
      threadId: "99",
    });
  });

  it("uses normal fallback merge when either side has no channel", () => {
    const merged = mergeDeliveryContext(
      { channel: "telegram" },
      { to: "123", accountId: "acct", threadId: "99" },
    );

    expect(merged).toEqual({
      channel: "telegram",
      to: "123",
      accountId: "acct",
      threadId: "99",
    });
  });

  it("builds stable keys only when channel and to are present", () => {
    expect(deliveryContextKey({ channel: "whatsapp", to: "+1555" })).toBe("whatsapp|+1555||");
    expect(deliveryContextKey({ channel: "whatsapp" })).toBeUndefined();
    expect(deliveryContextKey({ channel: "whatsapp", to: "+1555", accountId: "acct-1" })).toBe(
      "whatsapp|+1555|acct-1|",
    );
    expect(deliveryContextKey({ channel: "slack", to: "channel:C1", threadId: "123.456" })).toBe(
      "slack|channel:C1||123.456",
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
        lastThreadId: " 999 ",
      }),
    ).toEqual({
      channel: "telegram",
      to: "123",
      accountId: undefined,
      threadId: "999",
    });

    expect(
      deliveryContextFromSession({
        channel: "telegram",
        lastTo: " -1001 ",
        origin: { threadId: 42 },
      }),
    ).toEqual({
      channel: "telegram",
      to: "-1001",
      accountId: undefined,
      threadId: 42,
    });

    expect(
      deliveryContextFromSession({
        channel: "telegram",
        lastTo: " -1001 ",
        deliveryContext: { threadId: " 777 " },
        origin: { threadId: 42 },
      }),
    ).toEqual({
      channel: "telegram",
      to: "-1001",
      accountId: undefined,
      threadId: "777",
    });
  });

  it("normalizes delivery fields, mirrors session fields, and avoids cross-channel carryover", () => {
    const normalized = normalizeSessionDeliveryFields({
      deliveryContext: {
        channel: " Slack ",
        to: " channel:1 ",
        accountId: " acct-2 ",
        threadId: " 444 ",
      },
      lastChannel: " whatsapp ",
      lastTo: " +1555 ",
    });

    expect(normalized.deliveryContext).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: undefined,
    });
    expect(normalized.lastChannel).toBe("whatsapp");
    expect(normalized.lastTo).toBe("+1555");
    expect(normalized.lastAccountId).toBeUndefined();
    expect(normalized.lastThreadId).toBeUndefined();
  });
});
