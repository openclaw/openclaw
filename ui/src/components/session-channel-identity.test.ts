import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type Expected = Partial<NonNullable<SidebarRecentSession["channelPresentation"]>>;

function linked(
  channel: string,
  chatType: GatewaySessionRow["chatType"],
  peer: string,
  origin?: Omit<NonNullable<GatewaySessionRow["origin"]>, "provider">,
  extra: Partial<GatewaySessionRow> = {},
): Partial<GatewaySessionRow> {
  return {
    key: `agent:main:${channel}:${chatType}:${peer}`,
    channel,
    chatType,
    ...(origin ? { origin: { provider: channel, ...origin } } : {}),
    ...extra,
  };
}

const whatsappDirect = { channelLabel: "WhatsApp", kind: "direct" } as const;
const discordThread = { channelLabel: "Discord", kind: "thread" } as const;
const telegramTopic = { channelLabel: "Telegram", kind: "topic", topicId: "17" } as const;
const whatsapp = "15555550123";
const discord = "123:thread:456";
const telegram = "-123:topic:17";

it.each([
  [
    { key: "agent:main:email:direct:alex@example.com" },
    { channelLabel: "Email", kind: "direct", address: "alex@example.com" },
  ],
  [
    { key: "agent:main:matrix:direct:@alex:example.org" },
    { channelLabel: "Matrix", kind: "direct", address: "@alex:example.org" },
  ],
  [
    {
      key: "agent:main:whatsapp:direct:15555550123",
      origin: {
        provider: "whatsapp",
        from: "100000000@lid",
        to: "15555550999@s.whatsapp.net",
        label: "100000000@lid",
      },
    },
    { ...whatsappDirect, address: undefined, conversation: undefined },
  ],
  [
    linked("whatsapp", "direct", whatsapp, { from: "15555550123@s.whatsapp.net" }),
    { ...whatsappDirect, address: "+15555550123" },
  ],
  [
    linked(
      "whatsapp",
      "group",
      "120000000@g.us",
      { from: "120000000@g.us", label: "120000000@g.us" },
      { subject: "Weekend plans" },
    ),
    { channelLabel: "WhatsApp", kind: "group", conversation: "Weekend plans", address: undefined },
  ],
  [linked("discord", "channel", discord), discordThread],
  [linked("telegram", "group", telegram), telegramTopic],
  [
    linked("imessage", "direct", "alex@example.com", {
      from: "imessage:alex@example.com",
      to: "chat_id:12",
      label: "Alex",
    }),
    { channelLabel: "iMessage", address: "alex@example.com", conversation: "Alex" },
  ],
  [
    {
      key: "agent:main:signal:direct:+15555550123",
      channel: "signal",
      origin: { provider: "signal", from: "signal:+15555550123", label: "Alex id:+15555550123" },
    },
    { channelLabel: "Signal", address: "+15555550123", conversation: "Alex" },
  ],
  [
    {
      key: "agent:main:matrix:direct:@alex:example.org",
      channel: "matrix",
      origin: { provider: "matrix", nativeDirectUserId: "@Alex:Example.org" },
    },
    { channelLabel: "Matrix", address: "@Alex:Example.org" },
  ],
  [
    linked(
      "discord",
      "channel",
      discord,
      { label: "Example #releases channel id:123", threadId: "456" },
      { space: "999", groupChannel: "#releases" },
    ),
    { ...discordThread, conversation: "Example #releases" },
  ],
  [
    linked("telegram", "group", telegram, {
      label: "Planning id:-123 topic:17",
      threadId: 17,
    }),
    { ...telegramTopic, conversation: "Planning" },
  ],
  [
    linked("msteams", "group", "19:example", {}, { subject: "groupChat", space: "opaque-team-id" }),
    { channelLabel: "Microsoft Teams", kind: "group", conversation: undefined },
  ],
  [
    linked("custom", "channel", "example", undefined, {
      subject: "Design room",
      accountId: "work",
    }),
    { channelLabel: "Custom", kind: "channel", conversation: "Design room", account: "work" },
  ],
  [{ key: "agent:main:constructor:direct:42" }, { channelLabel: "Constructor", kind: "direct" }],
  [
    {
      key: "agent:main:whatsapp:direct:15555550123",
      channel: "telegram",
      chatType: "group",
      accountId: "telegram-bot",
      subject: "Wrong room",
      origin: { provider: "telegram", label: "Wrong person", from: "+15555550999" },
    },
    { ...whatsappDirect, address: "+15555550123", conversation: undefined, account: undefined },
  ],
] satisfies [Partial<GatewaySessionRow>, Expected][])("projects %j", (row, expected) => {
  expect(projectSidebarSession(row).channelPresentation).toMatchObject(expected);
});
