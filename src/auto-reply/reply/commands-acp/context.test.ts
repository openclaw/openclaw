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
const commandParams = (ctx: Parameters<typeof buildCommandTestParams>[2]) =>
  buildCommandTestParams("/acp status", {}, ctx);
const resolveContext = (ctx: Parameters<typeof commandParams>[0]) =>
  resolveAcpCommandBindingContext(commandParams(ctx));

const plugin = {
  ...createChannelTestPluginBase({
    id: "test-acp",
    config: { listAccountIds: () => ["default", "work"], defaultAccountId: () => "work" },
  }),
  bindings: { resolveCommandConversation, selfParentConversationByDefault: true },
};

beforeEach(() => {
  resolveCommandConversation.mockReset().mockReturnValue(null);
  setActivePluginRegistry(createTestRegistry([{ pluginId: "test-acp", source: "test", plugin }]));
});
afterEach(() => resetPluginRuntimeStateForTest());

it("passes authoritative command and message facts to the plugin resolver", () => {
  const conversation = { conversationId: "peer", parentConversationId: "parent" };
  resolveCommandConversation.mockReturnValue(conversation);
  const params = commandParams({
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

it.each([
  [undefined, { conversationId: "peer" }, { accountId: "work", conversationId: "peer" }],
  [undefined, null, { accountId: "work", threadId: undefined }],
  ["personal", null, { accountId: "personal", threadId: undefined }],
] as const)("resolves account %s / %j", (accountId, conversation, expected) => {
  resolveCommandConversation.mockReturnValue(conversation);
  expect(resolveContext({ OriginatingChannel: "test-acp", AccountId: accountId })).toEqual({
    channel: "test-acp",
    ...expected,
  });
});
