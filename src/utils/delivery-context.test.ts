import { describe, expect, it } from "vitest";
import { deliveryContextFromSession } from "./delivery-context.read.js";
import {
  deliveryContextKey,
  hasDeliveryTargetFields,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryState,
  projectSessionDeliveryFields,
} from "./delivery-context.shared.js";

const slackContext = {
  channel: "slack",
  to: "channel:C123",
  accountId: "work",
  threadId: "177000.123",
};

describe("delivery context helpers", () => {
  it("checks raw delivery target fields without trimming", () => {
    expect(hasDeliveryTargetFields({ channel: " ", to: " " })).toBe(true);
  });

  it("normalizes channel/to/accountId and drops empty contexts", () => {
    expect(
      normalizeDeliveryContext({ channel: " demo ", to: " +1555 ", accountId: " acct-1 " }),
    ).toEqual({ channel: "demo", to: "+1555", accountId: "acct-1" });
    expect(normalizeDeliveryContext({ channel: "  " })).toBeUndefined();
  });

  it.each([
    { channel: "other" },
    { channel: "telegram", accountId: "bot-a" },
    { accountId: "bot-a" },
  ])("does not inherit fallback route fields across owners: %j", (primary) => {
    expect(
      mergeDeliveryContext(primary, {
        channel: "telegram",
        to: "123",
        accountId: "bot-b",
        threadId: "99",
      }),
    ).toEqual({ channel: primary.channel, to: undefined, accountId: primary.accountId });
  });

  it("builds stable keys only when channel and to are present", () => {
    expect(deliveryContextKey({ channel: "demo", to: "+1555" })).toBe("demo|+1555||");
    expect(deliveryContextKey({ channel: "demo" })).toBeUndefined();
    expect(deliveryContextKey({ channel: "demo", to: "+1555", accountId: "acct-1" })).toBe(
      "demo|+1555|acct-1|",
    );
    expect(deliveryContextKey({ channel: "demo", to: "channel:C1", threadId: "123.456" })).toBe(
      "demo|channel:C1||123.456",
    );
    expect(deliveryContextKey({ channel: "telegram", to: "-100123", threadId: 42.9 })).toBe(
      "telegram|-100123||42",
    );
  });

  it("derives delivery context from a session entry", () => {
    const delivery = normalizeSessionDeliveryState({ context: { ...slackContext } });
    expect(deliveryContextFromSession({ delivery })).toEqual(slackContext);
  });

  it("does not reconstruct delivery from retired session fields at runtime", () => {
    expect(
      deliveryContextFromSession({
        route: { channel: "slack", target: { to: "channel:C123" } },
        lastChannel: "slack",
        lastTo: "channel:C123",
      } as unknown as { delivery?: never }),
    ).toBeUndefined();
  });

  it("normalizes the closed none, internal, and external states", () => {
    expect(normalizeSessionDeliveryState()).toEqual({ kind: "none" });
    expect(
      normalizeSessionDeliveryState({ context: { channel: "webchat", to: "dashboard" } }),
    ).toEqual({ kind: "internal" });

    expect(
      normalizeSessionDeliveryState({
        route: {
          channel: "Slack",
          accountId: " work ",
          target: { to: " channel:C123 ", rawTo: " slack://C123 ", chatType: "channel" },
          thread: { id: " 177000.123 ", kind: "thread", source: "target" },
        },
        context: { channel: "discord", to: "channel:old" },
        origin: { label: "Support" },
      }),
    ).toEqual({
      kind: "external",
      route: {
        channel: "slack",
        accountId: "work",
        target: { to: "channel:C123", rawTo: "slack://C123", chatType: "channel" },
        thread: { id: "177000.123", kind: "thread", source: "target" },
      },
      context: slackContext,
      origin: {
        label: "Support",
        provider: "slack",
        to: "channel:C123",
        accountId: "work",
        threadId: "177000.123",
        chatType: "channel",
      },
    });

    expect(
      normalizeSessionDeliveryState({
        route: { channel: "webchat", target: { to: "dashboard" } },
        context: { channel: "room-chat", to: "room:ops" },
      }),
    ).toMatchObject({
      kind: "external",
      route: { channel: "room-chat", target: { to: "room:ops" } },
      context: { channel: "room-chat", to: "room:ops" },
    });
  });

  it("projects compatibility fields without duplicating them in the session row", () => {
    const context = { channel: "telegram", to: "-1001", accountId: "bot", threadId: 42 };
    const delivery = normalizeSessionDeliveryState({
      context: { ...context },
      origin: { label: "Ops" },
    });
    const expectedProjection = {
      route: {
        channel: "telegram",
        accountId: "bot",
        target: { to: "-1001" },
        thread: { id: 42 },
      },
      deliveryContext: context,
      origin: { label: "Ops", provider: "telegram", to: "-1001", accountId: "bot", threadId: 42 },
      channel: "telegram",
      lastChannel: "telegram",
      lastTo: "-1001",
      lastAccountId: "bot",
      lastThreadId: 42,
    };
    const projection = projectSessionDeliveryFields(delivery);
    expect(projection).toEqual(expectedProjection);
    expect(JSON.stringify(projection)).toBe(JSON.stringify(expectedProjection));
  });
});
