import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

describe("sidebar linked conversation identity", () => {
  it.each([
    {
      name: "route-only WhatsApp direct chat",
      row: { key: "agent:main:whatsapp:direct:15555550123" },
      expected: { channelLabel: "WhatsApp", kind: "direct", address: "+15555550123" },
    },
    {
      name: "route-only email direct chat",
      row: { key: "agent:main:email:direct:alex@example.com" },
      expected: { channelLabel: "Email", kind: "direct", address: "alex@example.com" },
    },
    {
      name: "route-only Matrix direct chat",
      row: { key: "agent:main:matrix:direct:@alex:example.org" },
      expected: { channelLabel: "Matrix", kind: "direct", address: "@alex:example.org" },
    },
    {
      name: "current privacy identity instead of an older phone route",
      row: {
        key: "agent:main:whatsapp:direct:15555550123",
        origin: { provider: "whatsapp", from: "100000000@lid", to: "15555550999@s.whatsapp.net" },
      },
      expected: { channelLabel: "WhatsApp", kind: "direct", address: undefined },
    },
    {
      name: "WhatsApp phone JID",
      row: {
        key: "agent:main:whatsapp:direct:15555550123",
        channel: "whatsapp",
        chatType: "direct",
        origin: { provider: "whatsapp", from: "15555550123@s.whatsapp.net" },
      },
      expected: { channelLabel: "WhatsApp", kind: "direct", address: "+15555550123" },
    },
    {
      name: "WhatsApp group with session contributors",
      row: {
        key: "agent:main:whatsapp:group:120000000@g.us",
        channel: "whatsapp",
        chatType: "group",
        subject: "Weekend plans",
        origin: { provider: "whatsapp", from: "120000000@g.us", label: "120000000@g.us" },
        participantCount: 5,
      },
      expected: {
        channelLabel: "WhatsApp",
        kind: "group",
        conversation: "Weekend plans",
        address: undefined,
      },
    },
    {
      name: "WhatsApp privacy identifier",
      row: {
        key: "agent:main:whatsapp:direct:100000000@lid",
        channel: "whatsapp",
        origin: {
          provider: "whatsapp",
          from: "100000000@lid",
          to: "15555550999@s.whatsapp.net",
          label: "100000000@lid",
        },
      },
      expected: { channelLabel: "WhatsApp", address: undefined, conversation: undefined },
    },
    {
      name: "Discord thread without redundant origin metadata",
      row: {
        key: "agent:main:discord:channel:123:thread:456",
        channel: "discord",
        chatType: "channel",
      },
      expected: { channelLabel: "Discord", kind: "thread" },
    },
    {
      name: "Telegram topic without redundant origin metadata",
      row: {
        key: "agent:main:telegram:group:-123:topic:17",
        channel: "telegram",
        chatType: "group",
      },
      expected: { channelLabel: "Telegram", kind: "topic", topicId: "17" },
    },
    {
      name: "iMessage recipient email instead of local chat ID",
      row: {
        key: "agent:main:imessage:direct:alex@example.com",
        channel: "imessage",
        chatType: "direct",
        origin: {
          provider: "imessage",
          from: "imessage:alex@example.com",
          to: "chat_id:12",
          label: "Alex",
        },
      },
      expected: { channelLabel: "iMessage", address: "alex@example.com", conversation: "Alex" },
    },
    {
      name: "Signal phone number",
      row: {
        key: "agent:main:signal:direct:+15555550123",
        channel: "signal",
        origin: { provider: "signal", from: "signal:+15555550123", label: "Alex id:+15555550123" },
      },
      expected: { channelLabel: "Signal", address: "+15555550123", conversation: "Alex" },
    },
    {
      name: "Matrix handle with homeserver",
      row: {
        key: "agent:main:matrix:direct:@alex:example.org",
        channel: "matrix",
        origin: { provider: "matrix", nativeDirectUserId: "@Alex:Example.org" },
      },
      expected: { channelLabel: "Matrix", address: "@Alex:Example.org" },
    },
    {
      name: "Discord thread with server context",
      row: {
        key: "agent:main:discord:channel:123:thread:456",
        channel: "discord",
        chatType: "channel",
        origin: { provider: "discord", label: "Example #releases channel id:123", threadId: "456" },
        space: "999",
        groupChannel: "#releases",
      },
      expected: { channelLabel: "Discord", kind: "thread", conversation: "Example #releases" },
    },
    {
      name: "Slack workspace and channel",
      row: {
        key: "agent:main:slack:channel:c123:thread:123.456",
        channel: "slack",
        chatType: "channel",
        subject: "Example #releases",
        groupChannel: "#releases",
        space: "T123",
        origin: { provider: "slack", threadId: "123.456" },
      },
      expected: { channelLabel: "Slack", kind: "thread", conversation: "Example #releases" },
    },
    {
      name: "Telegram topic",
      row: {
        key: "agent:main:telegram:group:-123:topic:17",
        channel: "telegram",
        chatType: "group",
        origin: { provider: "telegram", label: "Planning id:-123 topic:17", threadId: 17 },
      },
      expected: {
        channelLabel: "Telegram",
        kind: "topic",
        conversation: "Planning",
        topicId: "17",
      },
    },
    {
      name: "Teams group without a readable title",
      row: {
        key: "agent:main:msteams:group:19:example",
        channel: "msteams",
        chatType: "group",
        subject: "groupChat",
        space: "opaque-team-id",
        origin: { provider: "msteams" },
      },
      expected: { channelLabel: "Microsoft Teams", kind: "group", conversation: undefined },
    },
    {
      name: "custom channel",
      row: {
        key: "agent:main:custom:channel:example",
        channel: "custom",
        chatType: "channel",
        subject: "Design room",
        accountId: "work",
      },
      expected: {
        channelLabel: "Custom",
        kind: "channel",
        conversation: "Design room",
        account: "work",
      },
    },
    {
      name: "constructor channel from an explicit session key",
      row: { key: "agent:main:constructor:direct:42" },
      expected: { channelLabel: "Constructor", kind: "direct" },
    },
    {
      name: "__proto__ channel from an explicit session key",
      row: { key: "agent:main:__proto__:channel:example" },
      expected: { channelLabel: "__proto__", kind: "channel" },
    },
    {
      name: "canonical peer instead of conflicting last-delivery metadata",
      row: {
        key: "agent:main:whatsapp:direct:15555550123",
        channel: "telegram",
        chatType: "group",
        accountId: "telegram-bot",
        subject: "Wrong room",
        origin: { provider: "telegram", label: "Wrong person", from: "+15555550999" },
      },
      expected: {
        channelLabel: "WhatsApp",
        kind: "direct",
        address: "+15555550123",
        conversation: undefined,
        account: undefined,
      },
    },
  ] satisfies {
    name: string;
    row: Partial<GatewaySessionRow>;
    expected: Partial<NonNullable<SidebarRecentSession["channelPresentation"]>>;
  }[])("projects $name from recorded conversation facts", ({ row, expected }) => {
    expect(projectSidebarSession(row).channelPresentation).toMatchObject(expected);
  });

  it.each(["agent:main:main", "agent:main:dashboard:chat", "agent:main:work", "global"])(
    "does not label %s as channel-linked because of its last delivery route",
    (key) => {
      expect(
        projectSidebarSession({
          key,
          channel: "whatsapp",
          chatType: "direct",
          origin: { provider: "whatsapp", from: "+15555550123" },
        }).channelPresentation,
      ).toBeUndefined();
    },
  );
});
