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

describe("dispatchChannelMessageAction conversation-read provenance", () => {
  const supportsAction = vi.fn(() => true);
  const requiresTrustedRequesterSender = vi.fn(() => false);

  function setReadPlugin(params?: {
    channel?: ChannelPlugin["id"];
    origin?: string;
    strayPolicy?: string;
  }) {
    const channel = params?.channel ?? "discord";
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: channel,
        label: channel,
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        ...(params?.strayPolicy
          ? ({ conversationReadPolicy: params.strayPolicy } as Record<string, unknown>)
          : {}),
        describeMessageTool: () => ({ actions: ["read", "send"] }),
        supportsAction,
        requiresTrustedRequesterSender,
        handleAction,
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: channel,
          source: "test",
          plugin,
          ...(params?.origin ? { origin: params.origin as never } : {}),
        },
      ]),
    );
  }

  beforeEach(() => {
    handleAction.mockClear();
    supportsAction.mockClear();
    requiresTrustedRequesterSender.mockClear();
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("allows a non-bundled delegated read of the exact current conversation and account", async () => {
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

  it("matches a sanitized channelId to a typed current-channel target", async () => {
    setReadPlugin();

    await dispatchChannelMessageAction({
      channel: "discord",
      action: "read",
      cfg: {} as OpenClawConfig,
      params: {
        target: "current",
        channelId: "current",
      },
      accountId: "default",
      requesterAccountId: "default",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:current",
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
  ])("rejects a non-bundled delegated read with $name before plugin code", async (testCase) => {
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
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(supportsAction).not.toHaveBeenCalled();
    expect(requiresTrustedRequesterSender).not.toHaveBeenCalled();
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("allows direct operators through a non-bundled adapter", async () => {
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
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not match a typed request to an untyped current target", async () => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: { target: "user:123" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "123",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not let a bare current-channel alias erase a trusted target kind", async () => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          target: "channel:123",
          channelId: "123",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "123",
          currentMessagingTarget: "user:123",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("fails closed when trusted current targets disagree on semantic kind", async () => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          target: "123",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "channel:123",
          currentMessagingTarget: "user:123",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("rejects conflicting target aliases even when one names the current conversation", async () => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          channelId: "current",
          target: "channel:other",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "channel:current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("keeps non-read actions compatible on a non-bundled adapter", async () => {
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

  it("delegates configured-target policy to a bundled adapter", async () => {
    setReadPlugin({ origin: "bundled" });

    await dispatchChannelMessageAction({
      channel: "discord",
      action: "read",
      cfg: {} as OpenClawConfig,
      params: { channelId: "configured" },
      conversationReadOrigin: "delegated",
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("keeps unaudited bundled adapters on the exact-current host limit", async () => {
    setReadPlugin({ channel: "telegram", origin: "bundled" });

    await expect(
      dispatchChannelMessageAction({
        channel: "telegram",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: { channelId: "configured" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not let an external adapter opt into bundled behavior with a stray property", async () => {
    setReadPlugin({
      origin: "workspace",
      strayPolicy: "current-or-configured-v1",
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: { channelId: "configured" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it.each([undefined, "unknown", "global", "workspace", "config"] as const)(
    "treats %s channel provenance as non-bundled",
    async (origin) => {
      setReadPlugin(origin ? { origin } : undefined);

      await expect(
        dispatchChannelMessageAction({
          channel: "discord",
          action: "read",
          cfg: {} as OpenClawConfig,
          params: { channelId: "configured" },
          accountId: "default",
          requesterAccountId: "default",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelProvider: "discord",
            currentChannelId: "current",
          },
        }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(handleAction).not.toHaveBeenCalled();
    },
  );
});
