// Message action security tests cover channel message action authorization and validation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin as registeredDiscordPlugin } from "../../../extensions/discord/api.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";
import type { ChannelPlugin } from "./types.js";

const handleAction = vi.fn(async () => jsonResult({ ok: true }));

const emptyRegistry = createTestRegistry([]);

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

describe("dispatchChannelMessageAction trusted sender guard", () => {
  beforeEach(() => {
    handleAction.mockClear();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
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

  it("rejects registered Discord moderation actions without trusted sender in Discord tool context", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: registeredDiscordPlugin as unknown as ChannelPlugin,
        },
      ]),
    );

    for (const toolContext of [
      { currentChannelProvider: "discord" },
      { currentChannelProvider: "discord", requesterSourceProvider: "discord-voice" },
    ] as const) {
      for (const action of ["timeout", "kick", "ban"] as const) {
        await expect(
          dispatchChannelMessageAction({
            channel: "discord",
            action,
            cfg: {
              channels: {
                discord: {
                  token: "Bot fake",
                  actions: { moderation: true },
                },
              },
            } as OpenClawConfig,
            params: { guildId: "g1", userId: "u1" },
            toolContext,
          }),
        ).rejects.toThrow(`Trusted sender identity is required for discord:${action}`);
      }
    }
  });

  it("rejects registered Discord moderation actions from non-Discord tool context", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: registeredDiscordPlugin as unknown as ChannelPlugin,
        },
      ]),
    );

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "ban",
        cfg: {
          channels: {
            discord: {
              token: "Bot fake",
              actions: { moderation: true },
            },
          },
        } as OpenClawConfig,
        params: { guildId: "g1", userId: "u1" },
        requesterSenderId: "telegram-user-id",
        toolContext: { currentChannelProvider: "telegram" },
      }),
    ).rejects.toThrow("requires a Discord requester context");
  });

  it("rejects registered Discord moderation actions without trusted context", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: registeredDiscordPlugin as unknown as ChannelPlugin,
        },
      ]),
    );

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "ban",
        cfg: {
          channels: {
            discord: {
              token: "Bot fake",
              actions: { moderation: true },
            },
          },
        } as OpenClawConfig,
        params: { guildId: "g1", userId: "u1" },
        requesterSenderId: "client-supplied-sender-id",
      }),
    ).rejects.toThrow("requires a trusted Discord requester sender");
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
      senderIsOwner: true,
    });

    expect(handleAction).toHaveBeenCalledOnce();
    expect(handleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        senderIsOwner: true,
      }),
    );
  });
});
