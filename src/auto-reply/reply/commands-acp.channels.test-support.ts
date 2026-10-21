import type { ChannelCommandConversationContext } from "../../channels/plugins/types.adapters.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

type Conversation = { conversationId: string; parentConversationId?: string };
type Resolver = (params: ChannelCommandConversationContext) => Conversation | null;

function commandTarget({
  originatingTo,
  commandTo,
  fallbackTo,
}: ChannelCommandConversationContext) {
  return [originatingTo, commandTo, fallbackTo].find((target) => target?.trim())?.trim();
}

function channel<T extends object>(id: string, label: string, resolve: Resolver, extra: T) {
  return {
    pluginId: id,
    source: "test",
    plugin: {
      ...createChannelTestPluginBase({ id, label }),
      bindings: { resolveCommandConversation: resolve },
      ...extra,
    },
  };
}

// These adapters cover the synthetic conversation shapes used by this suite;
// channel parsers and command-context precedence have their own owner tests.
export function setMinimalAcpCommandRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      channel(
        "telegram",
        "Telegram",
        (params) => {
          const chatId = commandTarget(params)?.replace(/^telegram:/i, "");
          if (!chatId || (!params.threadId && chatId.startsWith("-"))) {
            return null;
          }
          return {
            conversationId: params.threadId ? `${chatId}:topic:${params.threadId}` : chatId,
            parentConversationId: chatId,
          };
        },
        {
          conversationBindings: {
            defaultTopLevelPlacement: "current",
            buildBoundReplyPayload: ({
              operation,
              conversation,
            }: {
              operation: "acp-spawn";
              conversation: Conversation;
            }) =>
              operation === "acp-spawn" && conversation.conversationId.includes(":topic:")
                ? { delivery: { pin: { enabled: true } } }
                : null,
          },
        },
      ),
      channel(
        "discord",
        "Discord",
        (params) => {
          const target = commandTarget(params);
          const parent = target?.startsWith("channel:") ? target : undefined;
          return params.threadId
            ? {
                conversationId: params.threadId,
                ...(parent ? { parentConversationId: parent } : {}),
              }
            : parent
              ? { conversationId: parent }
              : null;
        },
        { conversationBindings: { defaultTopLevelPlacement: "child" } },
      ),
      channel(
        "slack",
        "Slack",
        (params) => {
          const conversationId = commandTarget(params);
          return conversationId ? { conversationId } : null;
        },
        {},
      ),
      channel(
        "matrix",
        "Matrix",
        (params) => {
          const roomId = commandTarget(params)?.replace(/^room:/i, "");
          return params.threadId && roomId
            ? { conversationId: params.threadId, parentConversationId: roomId }
            : null;
        },
        { conversationBindings: { defaultTopLevelPlacement: "child" } },
      ),
    ]),
  );
}
