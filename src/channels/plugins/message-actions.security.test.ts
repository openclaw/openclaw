// Message action security tests cover channel message action authorization and validation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { CONVERSATION_READ_POLICY_V1 } from "./conversation-read-origin.js";
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
});

describe("dispatchChannelMessageAction legacy conversation-read policy", () => {
  function setReadPlugin(params?: { conversationReadPolicy?: typeof CONVERSATION_READ_POLICY_V1 }) {
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        label: "Discord",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      messaging: {
        normalizeTarget: (raw) => raw.replace(/^discord:/, ""),
      },
      actions: {
        ...(params?.conversationReadPolicy
          ? { conversationReadPolicy: params.conversationReadPolicy }
          : {}),
        describeMessageTool: () => ({ actions: ["read", "send"] }),
        handleAction,
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));
  }

  beforeEach(() => {
    handleAction.mockClear();
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("allows an unattested delegated read of the exact current conversation and account", async () => {
    setReadPlugin();

    await dispatchChannelMessageAction({
      channel: "discord",
      action: "read",
      cfg: {} as OpenClawConfig,
      params: { channelId: "channel:current" },
      accountId: "Work",
      requesterAccountId: "work",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "discord:channel:current",
      },
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "cross-conversation target",
      params: { channelId: "other" },
      accountId: "default",
      requesterAccountId: "default",
    },
    {
      name: "missing target",
      params: {},
      accountId: "default",
      requesterAccountId: "default",
    },
    {
      name: "wrong account",
      params: { channelId: "current" },
      accountId: "other",
      requesterAccountId: "default",
    },
    {
      name: "missing requester account",
      params: { channelId: "current" },
      accountId: "default",
      requesterAccountId: undefined,
    },
    {
      name: "invalid account",
      params: { channelId: "current" },
      accountId: "!!!",
      requesterAccountId: "default",
    },
    {
      name: "missing current provider",
      params: { channelId: "current" },
      accountId: "default",
      requesterAccountId: "default",
      currentChannelProvider: undefined,
    },
    {
      name: "different current provider",
      params: { channelId: "current" },
      accountId: "default",
      requesterAccountId: "default",
      currentChannelProvider: "slack",
    },
  ])("rejects an unattested delegated read with $name before plugin code", async (testCase) => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: testCase.params,
        accountId: testCase.accountId,
        requesterAccountId: testCase.requesterAccountId,
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider:
            "currentChannelProvider" in testCase ? testCase.currentChannelProvider : "discord",
          currentChannelId: "current",
        },
      }),
    ).rejects.toThrow("requires a current conversation");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("allows direct operators through an unattested adapter", async () => {
    setReadPlugin();

    await dispatchChannelMessageAction({
      channel: "discord",
      action: "read",
      cfg: {} as OpenClawConfig,
      params: { channelId: "other" },
      conversationReadOrigin: "direct-operator",
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("does not confuse user and channel targets that share an identifier", async () => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: { channelId: "channel:123" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentMessagingTarget: "user:123",
        },
      }),
    ).rejects.toThrow("requires a current conversation");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("keeps non-read actions compatible on an unattested adapter", async () => {
    setReadPlugin();

    await dispatchChannelMessageAction({
      channel: "discord",
      action: "send",
      cfg: {} as OpenClawConfig,
      params: { to: "other" },
      conversationReadOrigin: "delegated",
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("delegates configured-target policy to an attested adapter", async () => {
    setReadPlugin({ conversationReadPolicy: CONVERSATION_READ_POLICY_V1 });

    await dispatchChannelMessageAction({
      channel: "discord",
      action: "read",
      cfg: {} as OpenClawConfig,
      params: { channelId: "configured" },
      conversationReadOrigin: "delegated",
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });
});
