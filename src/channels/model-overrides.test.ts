// Model override tests cover channel-level model selection and override precedence.
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { resolveChannelModelOverride } from "./model-overrides.js";

function createModelOverrideConfig(
  channel: string,
  models: Record<string, string>,
): OpenClawConfig {
  return { channels: { modelByChannel: { [channel]: models } } };
}

describe("resolveChannelModelOverride", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("passes channel kind to plugin-owned parent fallback resolution", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "channel-kind",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "channel-kind",
              label: "Channel Kind",
              capabilities: { chatTypes: ["group", "channel"] },
            }),
            messaging: {
              resolveSessionConversation: ({
                kind,
                rawId,
              }: {
                kind: "group" | "channel";
                rawId: string;
              }) => ({
                id: rawId,
                parentConversationCandidates: kind === "channel" ? ["thread-parent"] : [],
              }),
            },
          },
        },
      ]),
    );

    const resolved = resolveChannelModelOverride({
      cfg: createModelOverrideConfig("channel-kind", {
        "thread-parent": "demo-provider/demo-channel-model",
      }),
      channel: "channel-kind",
      groupId: "thread-123",
      groupChatType: "channel",
    });

    expect(resolved?.model).toBe("demo-provider/demo-channel-model");
    expect(resolved?.matchKey).toBe("thread-parent");
  });

  it("uses plugin-owned parent fallback candidates", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "scoped-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "scoped-chat",
              label: "Scoped Chat",
              capabilities: { chatTypes: ["group"] },
            }),
            conversationBindings: {
              buildModelOverrideParentCandidates: ({
                parentConversationId,
              }: {
                parentConversationId?: string | null;
              }) =>
                parentConversationId === "room:topic:thread:sender:user"
                  ? ["room:topic:thread", "room"]
                  : [],
            },
          },
        },
      ]),
    );

    const resolved = resolveChannelModelOverride({
      cfg: createModelOverrideConfig("scoped-chat", {
        "room:topic:thread": "demo-provider/demo-scoped-model",
      }),
      channel: "scoped-chat",
      groupId: "unrelated",
      parentSessionKey: "agent:main:scoped-chat:group:room:topic:thread:sender:user",
    });

    expect(resolved?.model).toBe("demo-provider/demo-scoped-model");
    expect(resolved?.matchKey).toBe("room:topic:thread");
  });

  it("applies provider wildcard model overrides to direct chats", () => {
    const resolved = resolveChannelModelOverride({
      cfg: createModelOverrideConfig("telegram", {
        "*": "demo-provider/demo-direct-model",
      }),
      channel: "telegram",
      groupChatType: "direct",
    });

    expect(resolved?.model).toBe("demo-provider/demo-direct-model");
    expect(resolved?.matchKey).toBe("*");
    expect(resolved?.matchSource).toBe("wildcard");
  });

  it("prefers parent conversation ids over channel-name fallbacks", () => {
    const resolved = resolveChannelModelOverride({
      cfg: createModelOverrideConfig("telegram", {
        "-100123": "demo-provider/demo-parent-model",
        "#general": "demo-provider/demo-channel-name-model",
      }),
      channel: "telegram",
      groupId: "-100123:topic:99",
      groupChannel: "#general",
    });

    expect(resolved?.model).toBe("demo-provider/demo-parent-model");
    expect(resolved?.matchKey).toBe("-100123");
  });

  it("matches slack DM when origin.from is slack:U... but config has user:U... (multi-candidate)", () => {
    const resolved = resolveChannelModelOverride({
      cfg: createModelOverrideConfig("slack", {
        "user:U12345": "demo-provider/demo-slack-dm-model",
      }),
      channel: "slack",
      groupChatType: "direct",
      directUserIds: ["slack:U12345", "user:U12345"],
    });

    expect(resolved?.model).toBe("demo-provider/demo-slack-dm-model");
    expect(resolved?.matchKey).toBe("user:U12345");
  });

  it("does not leak directUserId match into non-direct conversations", () => {
    const resolved = resolveChannelModelOverride({
      cfg: createModelOverrideConfig("telegram", {
        user123: "demo-provider/demo-dm-model",
      }),
      channel: "telegram",
      groupChatType: "group",
      groupId: "some-group",
      directUserIds: ["user123"],
    });

    expect(resolved).toBeNull();
  });
});
