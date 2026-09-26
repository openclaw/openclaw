// Tests the ACP command boundary around plugin-owned conversation resolution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelCommandConversationContext } from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { buildCommandTestParams } from "../commands-spawn.test-harness.js";
import { resolveAcpCommandBindingContext } from "./context.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;
const resolveCommandConversation = vi.fn(
  (
    _params: ChannelCommandConversationContext,
  ): {
    conversationId: string;
    parentConversationId?: string;
  } | null => null,
);

function installContextPlugin(selfParentConversationByDefault = false): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "test-acp",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "test-acp",
            config: {
              listAccountIds: () => ["default", "work"],
              defaultAccountId: () => "work",
            },
          }),
          bindings: { resolveCommandConversation, selfParentConversationByDefault },
        },
      },
    ]),
  );
}

describe("commands-acp context", () => {
  beforeEach(() => {
    resolveCommandConversation.mockReset().mockReturnValue(null);
    installContextPlugin();
  });
  afterEach(() => resetPluginRuntimeStateForTest());

  it("passes authoritative command and message facts to the plugin resolver", () => {
    resolveCommandConversation.mockReturnValue({
      conversationId: "plugin-conversation",
      parentConversationId: "plugin-parent",
    });
    const params = buildCommandTestParams("/acp sessions", baseCfg, {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "test-acp",
      OriginatingTo: "origin-target",
      To: "fallback-target",
      From: "source-sender",
      ChatType: "group",
      AccountId: "explicit-account",
      MessageThreadId: 42,
      ThreadParentId: "native-parent",
      SenderId: "context-sender",
      SessionKey: "context-session",
      ParentSessionKey: "parent-session",
    });
    params.command.senderId = "command-sender";
    params.command.to = "command-target";
    params.sessionKey = "command-session";

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "test-acp",
      accountId: "explicit-account",
      threadId: "42",
      conversationId: "plugin-conversation",
      parentConversationId: "plugin-parent",
    });
    expect(resolveCommandConversation).toHaveBeenCalledExactlyOnceWith({
      accountId: "explicit-account",
      threadId: "42",
      threadParentId: "native-parent",
      senderId: "command-sender",
      sessionKey: "command-session",
      parentSessionKey: "parent-session",
      from: "source-sender",
      chatType: "group",
      originatingTo: "origin-target",
      commandTo: "command-target",
      fallbackTo: "fallback-target",
    });
  });

  it("drops plugin self-parent defaults before ACP binding lookup", () => {
    installContextPlugin(true);
    resolveCommandConversation.mockReturnValue({ conversationId: "peer" });
    const params = buildCommandTestParams("/acp status", baseCfg, {
      OriginatingChannel: "test-acp",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "test-acp",
      accountId: "work",
      conversationId: "peer",
    });
  });

  it("falls back to the default account and generic target resolution", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      To: "<#123456789>",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "slack",
      accountId: "default",
      conversationId: "123456789",
    });
  });

  it.each([
    { accountId: undefined, expected: "work" },
    { accountId: "personal", expected: "personal" },
  ])("keeps account $expected when no conversation can be resolved", ({ accountId, expected }) => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      OriginatingChannel: "test-acp",
      AccountId: accountId,
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "test-acp",
      accountId: expected,
      threadId: undefined,
    });
  });
});
