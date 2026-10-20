import { beforeEach, describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { resolveChannelModelOverride } from "./model-overrides.js";
import type { ChannelPlugin } from "./plugins/types.public.js";

function resolve(
  channel: string,
  models: Record<string, string>,
  params: Omit<Parameters<typeof resolveChannelModelOverride>[0], "cfg" | "channel">,
) {
  return resolveChannelModelOverride({
    cfg: { channels: { modelByChannel: { [channel]: models } } },
    channel,
    ...params,
  });
}

function installPlugin(
  id: string,
  hooks: Pick<ChannelPlugin, "messaging" | "conversationBindings">,
  chatTypes: ("group" | "channel")[] = ["group"],
) {
  const plugin = {
    ...createChannelTestPluginBase({ id, label: id, capabilities: { chatTypes } }),
    ...hooks,
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: id, source: "test", plugin }]));
}

function expectMatch(result: ReturnType<typeof resolve>, model: string, matchKey: string) {
  expect(result).toMatchObject({ model, matchKey });
}

describe("resolveChannelModelOverride", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("passes channel kind to plugin-owned parent fallback resolution", () => {
    installPlugin(
      "channel-kind",
      {
        messaging: {
          resolveSessionConversation: ({ kind, rawId }) => ({
            id: rawId,
            parentConversationCandidates: kind === "channel" ? ["thread-parent"] : [],
          }),
        },
      },
      ["group", "channel"],
    );

    const resolved = resolve(
      "channel-kind",
      { "thread-parent": "demo/channel" },
      { groupId: "thread-123", groupChatType: "channel" },
    );

    expectMatch(resolved, "demo/channel", "thread-parent");
  });

  it("uses plugin-owned parent fallback candidates", () => {
    installPlugin("scoped-chat", {
      conversationBindings: {
        buildModelOverrideParentCandidates: ({ parentConversationId }) =>
          parentConversationId === "room:topic:thread:sender:user"
            ? ["room:topic:thread", "room"]
            : [],
      },
    });

    const resolved = resolve(
      "scoped-chat",
      { "room:topic:thread": "demo/scoped" },
      {
        groupId: "unrelated",
        parentSessionKey: "agent:main:scoped-chat:group:room:topic:thread:sender:user",
      },
    );

    expectMatch(resolved, "demo/scoped", "room:topic:thread");
  });

  it("applies provider wildcard model overrides to direct chats", () => {
    const resolved = resolve("telegram", { "*": "demo/direct" }, { groupChatType: "direct" });

    expect(resolved).toMatchObject({
      model: "demo/direct",
      matchKey: "*",
      matchSource: "wildcard",
    });
  });

  it("prefers parent conversation ids over channel-name fallbacks", () => {
    const resolved = resolve(
      "telegram",
      { "-100123": "demo/parent", "#general": "demo/name" },
      { groupId: "-100123:topic:99", groupChannel: "#general" },
    );

    expectMatch(resolved, "demo/parent", "-100123");
  });

  it("matches slack DM when origin.from is slack:U... but config has user:U... (multi-candidate)", () => {
    const resolved = resolve(
      "slack",
      { "user:U12345": "demo/slack-dm" },
      { groupChatType: "direct", directUserIds: ["slack:U12345", "user:U12345"] },
    );

    expectMatch(resolved, "demo/slack-dm", "user:U12345");
  });

  it("does not leak directUserId match into non-direct conversations", () => {
    const resolved = resolve(
      "telegram",
      { user123: "demo/dm" },
      { groupChatType: "group", groupId: "some-group", directUserIds: ["user123"] },
    );

    expect(resolved).toBeNull();
  });
});
