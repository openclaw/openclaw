import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelConfiguredBindingProvider } from "../../../channels/plugins/types.adapters.js";
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

const resolveCommandConversation =
  vi.fn<NonNullable<ChannelConfiguredBindingProvider["resolveCommandConversation"]>>();
function commandParams(ctx: Parameters<typeof buildCommandTestParams>[2]) {
  return buildCommandTestParams("/acp status", {}, ctx);
}

function expectContext(
  ctx: Parameters<typeof commandParams>[0],
  expected: ReturnType<typeof resolveAcpCommandBindingContext>,
) {
  expect(resolveAcpCommandBindingContext(commandParams(ctx))).toEqual(expected);
}

const plugin = {
  ...createChannelTestPluginBase({
    id: "test-acp",
    config: { listAccountIds: () => ["default", "work"], defaultAccountId: () => "work" },
  }),
  bindings: { resolveCommandConversation, selfParentConversationByDefault: false },
};

beforeEach(() => {
  resolveCommandConversation.mockReset().mockReturnValue(null);
  plugin.bindings.selfParentConversationByDefault = false;
  setActivePluginRegistry(createTestRegistry([{ pluginId: "test-acp", source: "test", plugin }]));
});
afterEach(() => resetPluginRuntimeStateForTest());

it("passes authoritative command and message facts to the plugin resolver", () => {
  const conversation = { conversationId: "peer", parentConversationId: "parent" };
  resolveCommandConversation.mockReturnValue(conversation);
  const params = commandParams({
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
    ...conversation,
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
  plugin.bindings.selfParentConversationByDefault = true;
  resolveCommandConversation.mockReturnValue({ conversationId: "peer" });
  expectContext(
    { OriginatingChannel: "test-acp" },
    { channel: "test-acp", accountId: "work", conversationId: "peer" },
  );
});

it("falls back to the default account and generic target resolution", () => {
  expectContext(
    { Provider: "slack", Surface: "slack", OriginatingChannel: "slack", To: "<#123456789>" },
    { channel: "slack", accountId: "default", conversationId: "123456789" },
  );
});

it.each([
  { accountId: undefined, expected: "work" },
  { accountId: "personal", expected: "personal" },
])("keeps account $expected when no conversation can be resolved", ({ accountId, expected }) => {
  expectContext(
    { OriginatingChannel: "test-acp", AccountId: accountId },
    { channel: "test-acp", accountId: expected, threadId: undefined },
  );
});
