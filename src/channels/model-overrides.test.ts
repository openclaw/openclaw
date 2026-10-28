import { beforeEach, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { resolveChannelModelOverride } from "./model-overrides.js";
import type { ChannelPlugin } from "./plugins/types.public.js";
type Input = Parameters<typeof resolveChannelModelOverride>[0];
type Match = Partial<NonNullable<ReturnType<typeof resolveChannelModelOverride>>>;

function resolve(
  channel: string,
  models: Record<string, string>,
  params: Omit<Input, "cfg" | "channel">,
) {
  return resolveChannelModelOverride({
    cfg: { channels: { modelByChannel: { [channel]: models } } },
    channel,
    ...params,
  });
}

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createSessionConversationTestRegistry());
});

it("uses channel-kind and parent-session plugin candidates", () => {
  const id = "channel-kind";
  const plugin = {
    ...createChannelTestPluginBase({
      id,
      label: id,
      capabilities: { chatTypes: ["group", "channel"] },
    }),
    messaging: {
      resolveSessionConversation: ({ kind, rawId }) => ({
        id: rawId,
        parentConversationCandidates: kind === "channel" ? ["thread-parent"] : [],
      }),
    },
    conversationBindings: {
      buildModelOverrideParentCandidates: ({ parentConversationId }) =>
        parentConversationId === "room:topic:thread:sender:user"
          ? ["room:topic:thread", "room"]
          : [],
    },
  } satisfies ChannelPlugin;
  setActivePluginRegistry(createTestRegistry([{ pluginId: id, source: "test", plugin }]));

  const resolved = resolve(
    "channel-kind",
    { "thread-parent": "demo/channel" },
    { groupId: "thread-123", groupChatType: "channel" },
  );

  expect(resolved).toMatchObject({ model: "demo/channel", matchKey: "thread-parent" });
  const parentMatch = resolve(
    "channel-kind",
    { "room:topic:thread": "demo/scoped" },
    {
      groupId: "unrelated",
      parentSessionKey: "agent:main:channel-kind:group:room:topic:thread:sender:user",
    },
  );

  expect(parentMatch).toMatchObject({ model: "demo/scoped", matchKey: "room:topic:thread" });
});

it.each<[string, string, Record<string, string>, Parameters<typeof resolve>[2], Match]>([
  [
    "provider wildcard for direct chats",
    "telegram",
    { "*": "demo/direct" },
    { groupChatType: "direct" },
    { model: "demo/direct", matchKey: "*", matchSource: "wildcard" },
  ],
  [
    "parent id before channel-name fallback",
    "telegram",
    { "-100123": "demo/parent", "#general": "demo/name" },
    { groupId: "-100123:topic:99", groupChannel: "#general" },
    { model: "demo/parent", matchKey: "-100123" },
  ],
  [
    "Slack DM multi-candidate matching",
    "slack",
    { "user:U12345": "demo/slack-dm" },
    { groupChatType: "direct", directUserIds: ["slack:U12345", "user:U12345"] },
    { model: "demo/slack-dm", matchKey: "user:U12345" },
  ],
])("resolves %s", (_name, channel, models, input, expected) => {
  expect(resolve(channel, models, input)).toMatchObject(expected);
});

it("does not leak directUserId match into non-direct conversations", () => {
  const resolved = resolve(
    "telegram",
    { user123: "demo/dm" },
    { groupChatType: "group", groupId: "some-group", directUserIds: ["user123"] },
  );

  expect(resolved).toBeNull();
});
