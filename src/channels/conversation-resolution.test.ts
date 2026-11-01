import { afterEach, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  resolveCommandConversationResolution as command,
  resolveInboundConversationResolution as inbound,
} from "./conversation-resolution.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";

type Plugin = Omit<Partial<ChannelPlugin>, "id" | "config"> & {
  id: string;
  config?: Partial<ChannelPlugin["config"]>;
};
function register({ id, config, ...overrides }: Plugin) {
  const plugin = { ...createChannelTestPluginBase({ id, config }), ...overrides };
  setActivePluginRegistry(createTestRegistry([{ pluginId: id, source: "test", plugin }]));
}
const bindings = (overrides: Partial<NonNullable<ChannelPlugin["bindings"]>>) => ({
  compileConfiguredBinding: () => null,
  matchInboundConversation: () => null,
  ...overrides,
});
afterEach(() => setActivePluginRegistry(createTestRegistry()));

type Expected = [conversationId: string, parentConversationId?: string, accountId?: string];
type CommandCase = [string, Plugin, string, Expected, string?];
it.each<CommandCase>([
  [
    "runtime resolver and default account",
    {
      id: "discord",
      config: { defaultAccountId: () => "work" },
      bindings: bindings({ resolveCommandConversation: () => ({ conversationId: "channel:123" }) }),
    },
    "discord:channel:123",
    ["channel:123", undefined, "work"],
  ],
  [
    "self-parent default",
    {
      id: "line",
      bindings: bindings({
        selfParentConversationByDefault: true,
        resolveCommandConversation: () => ({ conversationId: "user:U123" }),
      }),
    },
    "line:user:U123",
    ["user:U123", "user:U123"],
  ],
  [
    "focused binding normalization",
    {
      id: "line",
      threading: {
        resolveFocusedBinding: () => ({
          conversationId: "  user:U123  ",
          parentConversationId: "  room:R123  ",
          placement: "current",
          labelNoun: "conversation",
        }),
      },
    },
    "ignored",
    ["user:U123", "room:R123"],
    " default ",
  ],
  [
    "alias-prefixed topic fallback",
    {
      id: "telegram",
      messaging: {
        targetPrefixes: ["tg"],
        normalizeTarget: () => "telegram:group:-100123:topic:77",
      },
    },
    "tg:group:-100123:topic:77",
    ["-100123"],
  ],
  [
    "undeclared raw shorthand",
    {
      id: "plainchat",
      messaging: { normalizeTarget: () => "plainchat:-100123:77" },
    },
    "-100123:77",
    ["-100123:77"],
  ],
])("resolves %s", (_name, plugin, to, expected, accountId) => {
  const [conversationId, parentConversationId, expectedAccount = "default"] = expected;
  register(plugin);
  expect(command({ cfg: {}, channel: plugin.id, originatingTo: to, accountId })).toEqual({
    channel: plugin.id,
    accountId: expectedAccount,
    conversationId,
    parentConversationId,
  });
});

it.each(["command", "inbound"])("normalizes numeric %s thread ids", (entrypoint) => {
  register({ id: "test-chat" });
  const common = { cfg: {}, channel: "test-chat", threadId: 42.9 };
  const target = "test-chat:channel:parent-room";
  const result =
    entrypoint === "command"
      ? command({ ...common, originatingTo: target, accountId: "default" })
      : inbound({ ...common, to: target });
  expect(result).toEqual({
    channel: "test-chat",
    accountId: "default",
    conversationId: "42",
    parentConversationId: "parent-room",
    threadId: "42",
  });
});

it("keeps provider-resolved Matrix room casing for child threads", () => {
  register({
    id: "matrix",
    messaging: {
      resolveInboundConversation: () => ({
        conversationId: "$thread-root",
        parentConversationId: "!Room:Example.org",
      }),
    },
  });
  expect(
    inbound({ cfg: {}, channel: "matrix", to: "room:!Room:Example.org", threadId: "$thread-root" }),
  ).toEqual({
    channel: "matrix",
    accountId: "default",
    conversationId: "$thread-root",
    parentConversationId: "!Room:Example.org",
    threadId: "$thread-root",
  });
});
