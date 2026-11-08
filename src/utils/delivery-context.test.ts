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

const slackRoute = {
  channel: "slack",
  accountId: "work",
  target: { to: "channel:C123", rawTo: "slack://C123", chatType: "channel" as const },
  thread: { id: "177000.123", kind: "thread" as const, source: "target" as const },
};
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
    const input = { channel: " demo ", to: " C1 ", accountId: " a " };
    expect(normalizeDeliveryContext(input)).toEqual({ channel: "demo", to: "C1", accountId: "a" });
    expect(normalizeDeliveryContext({ channel: "  " })).toBeUndefined();
  });

  it.each([
    ["slack", undefined],
    ["telegram", "bot-a"],
    [undefined, "bot-a"],
  ] as const)("does not inherit target or thread across route owners: %j", (channel, accountId) => {
    const fallback = { channel: "telegram", accountId: "bot-b", to: "123", threadId: "99" };
    expect(mergeDeliveryContext({ channel, accountId }, fallback)).toEqual({
      channel,
      accountId,
      to: undefined,
    });
  });

  it.each([
    [{ channel: "demo", to: "C1" }, "demo|C1||"],
    [{ channel: "demo" }, undefined],
    [{ channel: "demo", to: "C1", accountId: "a" }, "demo|C1|a|"],
    [{ channel: "demo", to: "C1", threadId: "123.456" }, "demo|C1||123.456"],
  ] as const)("builds stable keys for %j", (context, key) => {
    expect(deliveryContextKey(context)).toBe(key);
  });

  it("does not reconstruct delivery from retired session fields at runtime", () => {
    expect(
      deliveryContextFromSession({
        route: slackRoute,
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

    const delivery = normalizeSessionDeliveryState({
      route: {
        ...slackRoute,
        channel: "Slack",
        accountId: " work ",
        target: { ...slackRoute.target, to: " channel:C123 ", rawTo: " slack://C123 " },
        thread: { ...slackRoute.thread, id: " 177000.123 " },
      },
      context: { channel: "discord", to: "channel:old" },
      origin: { label: "Support" },
    });
    expect(deliveryContextFromSession({ delivery })).toEqual(slackContext);
    expect(delivery).toEqual({
      kind: "external",
      route: slackRoute,
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
    const origin = {
      label: "Ops",
      provider: "telegram",
      to: "-1001",
      accountId: "bot",
      threadId: 42,
    };
    const delivery = normalizeSessionDeliveryState({
      context,
      origin: { label: "Ops" },
    });
    expect(projectSessionDeliveryFields(delivery)).toEqual({
      route: {
        channel: "telegram",
        accountId: "bot",
        target: { to: "-1001" },
        thread: { id: 42 },
      },
      deliveryContext: context,
      origin,
      channel: "telegram",
      lastChannel: "telegram",
      lastTo: "-1001",
      lastAccountId: "bot",
      lastThreadId: 42,
    });
  });
});
