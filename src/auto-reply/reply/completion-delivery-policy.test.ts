import { describe, expect, it } from "vitest";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  completionRequiresMessageToolDelivery,
  resolveCompletionChatType,
  shouldRouteCompletionThroughRequesterSession,
} from "./completion-delivery-policy.js";

type ResolveCompletionChatTypeCase = {
  name: string;
  requesterSessionKey: string;
  requesterSessionOrigin: DeliveryContext;
  expected: string;
};

describe("completion delivery policy", () => {
  it.each<ResolveCompletionChatTypeCase>([
    {
      name: "typed group origin",
      requesterSessionKey: "agent:main:telegram:group:-100123",
      requesterSessionOrigin: { channel: "telegram", to: "-100123", chatType: "group" },
      expected: "group",
    },
    {
      name: "typed channel origin",
      requesterSessionKey: "agent:main:slack:channel:C123",
      requesterSessionOrigin: { channel: "slack", to: "channel:C123", chatType: "channel" },
      expected: "channel",
    },
    {
      name: "typed direct origin",
      requesterSessionKey: "agent:main:discord:dm:U123",
      requesterSessionOrigin: { channel: "discord", to: "user:U123", chatType: "direct" },
      expected: "direct",
    },
  ])("infers $name", ({ requesterSessionKey, requesterSessionOrigin, expected }) => {
    expect(resolveCompletionChatType({ requesterSessionKey, requesterSessionOrigin })).toBe(
      expected,
    );
  });

  it("prefers explicit session chat type over typed origin", () => {
    expect(
      resolveCompletionChatType({
        requesterSessionKey: "agent:main:slack:channel:C123",
        requesterEntry: { chatType: "direct" },
      }),
    ).toBe("direct");
  });

  it("prefers typed delivery-context chat type over target prefix", () => {
    expect(
      resolveCompletionChatType({
        requesterSessionKey: "agent:main:opaque:legacy-key",
        requesterSessionOrigin: { channel: "notifychat", to: "123", chatType: "group" },
      }),
    ).toBe("group");
  });

  it.each([
    { to: "group:ops", expected: "group" },
    { to: "channel:C123", expected: "channel" },
    { to: "thread:171.222", expected: "channel" },
    { to: "dm:U123", expected: "direct" },
    { to: "direct:U123", expected: "direct" },
    { to: "user:U123", expected: "direct" },
  ] as const)("falls back to origin target prefix $to", ({ to, expected }) => {
    expect(
      resolveCompletionChatType({
        requesterSessionKey: "agent:main:opaque:unknown-target",
        directOrigin: { channel: "test", to },
      }),
    ).toBe(expected);
  });

  it("requires message-tool delivery for group and channel completions by default", () => {
    expect(
      completionRequiresMessageToolDelivery({
        cfg: {},
        requesterSessionKey: "agent:main:whatsapp:group:123@g.us",
        requesterSessionOrigin: { channel: "whatsapp", to: "123@g.us", chatType: "group" },
      }),
    ).toBe(true);
    expect(
      completionRequiresMessageToolDelivery({
        cfg: {},
        requesterSessionKey: "agent:main:discord:guild:123:channel:456",
        requesterSessionOrigin: { channel: "discord", to: "channel:456", chatType: "channel" },
      }),
    ).toBe(true);
  });

  it("honors automatic group visible-reply config", () => {
    expect(
      completionRequiresMessageToolDelivery({
        cfg: { messages: { groupChat: { visibleReplies: "automatic" } } },
        requesterSessionKey: "agent:main:slack:channel:C123",
        requesterSessionOrigin: { channel: "slack", to: "channel:C123", chatType: "channel" },
      }),
    ).toBe(false);
  });

  it("requires message-tool delivery for direct completions only when globally configured", () => {
    expect(
      completionRequiresMessageToolDelivery({
        cfg: {},
        requesterSessionKey: "agent:main:discord:dm:U123",
        requesterSessionOrigin: { channel: "discord", to: "user:U123", chatType: "direct" },
      }),
    ).toBe(false);
    expect(
      completionRequiresMessageToolDelivery({
        cfg: { messages: { visibleReplies: "message_tool" } },
        requesterSessionKey: "agent:main:discord:dm:U123",
        requesterSessionOrigin: { channel: "discord", to: "user:U123", chatType: "direct" },
      }),
    ).toBe(true);
  });

  it("routes group and channel task completions through the requester session", () => {
    expect(
      shouldRouteCompletionThroughRequesterSession({
        requesterSessionKey: "agent:main:whatsapp:group:123@g.us",
        requesterSessionOrigin: { channel: "whatsapp", to: "123@g.us", chatType: "group" },
      }),
    ).toBe(true);
    expect(
      shouldRouteCompletionThroughRequesterSession({
        requesterSessionKey: "agent:main:discord:guild:123:channel:456",
        requesterSessionOrigin: { channel: "discord", to: "channel:456", chatType: "channel" },
      }),
    ).toBe(true);
    expect(
      shouldRouteCompletionThroughRequesterSession({
        requesterSessionKey: "agent:main:discord:dm:U123",
        requesterSessionOrigin: { channel: "discord", to: "user:U123", chatType: "direct" },
      }),
    ).toBe(false);
    expect(
      shouldRouteCompletionThroughRequesterSession({
        requesterSessionKey: "agent:main:opaque:legacy-key",
        requesterSessionOrigin: { channel: "notifychat", to: "123", chatType: "channel" },
      }),
    ).toBe(true);
  });
});
