// Message action security tests cover channel message action authorization and validation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";
import type { ChannelMessageActionName, ChannelPlugin } from "./types.js";

const handleAction = vi.fn(async () => jsonResult({ ok: true }));

const emptyRegistry = createTestRegistry([]);
const legacyProtectedActions = new Set<ChannelMessageActionName>([
  "kick",
  "topic-create",
  "topic-edit",
]);

const discordPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "discord",
    label: "Discord",
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => ["default"],
    },
  }),
  actions: {
    describeMessageTool: () => ({ actions: ["kick"] }),
    supportsAction: ({ action }) => action === "kick",
    requiresTrustedRequesterSender: ({ action, toolContext }) =>
      Boolean(action === "kick" && toolContext),
    handleAction,
  },
};

const legacyModerationPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "legacy-chat",
    label: "Legacy Chat",
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => ["default"],
    },
  }),
  actions: {
    describeMessageTool: () => ({ actions: Array.from(legacyProtectedActions) }),
    supportsAction: ({ action }) => legacyProtectedActions.has(action),
    handleAction,
  },
};

describe("dispatchChannelMessageAction trusted sender guard", () => {
  beforeEach(() => {
    handleAction.mockClear();
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "discord", source: "test", plugin: discordPlugin },
        { pluginId: "legacy-chat", source: "test", plugin: legacyModerationPlugin },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("rejects privileged discord moderation action without trusted sender in tool context", async () => {
    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "kick",
        cfg: {} as OpenClawConfig,
        params: { guildId: "g1", userId: "u1" },
        toolContext: { currentChannelProvider: "discord" },
      }),
    ).rejects.toThrow("Trusted sender identity is required for discord:kick");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("allows privileged discord moderation action with trusted sender in tool context", async () => {
    await dispatchChannelMessageAction({
      channel: "discord",
      action: "kick",
      cfg: {} as OpenClawConfig,
      params: { guildId: "g1", userId: "u1" },
      requesterSenderId: "trusted-user",
      toolContext: { currentChannelProvider: "discord" },
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("does not require trusted sender without tool context", async () => {
    await dispatchChannelMessageAction({
      channel: "discord",
      action: "kick",
      cfg: {} as OpenClawConfig,
      params: { guildId: "g1", userId: "u1" },
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("rejects canonical protected actions even when the plugin omits the hook", async () => {
    for (const action of legacyProtectedActions) {
      await expect(
        dispatchChannelMessageAction({
          channel: "legacy-chat",
          action,
          cfg: {} as OpenClawConfig,
          params: { groupId: "g1", userId: "u1" },
          toolContext: { currentChannelProvider: "legacy-chat" },
        }),
      ).rejects.toThrow(`Trusted sender identity is required for legacy-chat:${action}`);
    }
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("allows canonical protected actions with trusted sender when the plugin omits the hook", async () => {
    await dispatchChannelMessageAction({
      channel: "legacy-chat",
      action: "topic-create",
      cfg: {} as OpenClawConfig,
      params: { groupId: "g1", userId: "u1" },
      requesterSenderId: "trusted-user",
      toolContext: { currentChannelProvider: "legacy-chat" },
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("rejects a different channel sender for canonical protected actions", async () => {
    await expect(
      dispatchChannelMessageAction({
        channel: "legacy-chat",
        action: "topic-edit",
        cfg: {} as OpenClawConfig,
        params: { groupId: "g1", userId: "u1" },
        requesterSenderId: "other-channel-user",
        toolContext: { currentChannelProvider: "other-chat" },
      }),
    ).rejects.toThrow(
      "Trusted sender identity for legacy-chat:topic-edit must come from legacy-chat, not other-chat",
    );

    expect(handleAction).not.toHaveBeenCalled();
  });
});
