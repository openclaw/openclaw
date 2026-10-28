import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

type Conversation = { conversationId: string; parentConversationId?: string };
function channel<T extends object>(
  id: string,
  conversations: Record<string, Conversation>,
  extra: T,
) {
  return {
    pluginId: id,
    source: "test",
    plugin: {
      ...createChannelTestPluginBase({ id }),
      bindings: {
        resolveCommandConversation: (params: { originatingTo?: string; threadId?: string }) =>
          conversations[`${params.originatingTo}/${params.threadId ?? ""}`] ?? null,
      },
      ...extra,
    },
  };
}

// Fixed adapter outputs, not copies of channel parsers. The context owner tests
// cover which command/message facts reach a plugin; these tests consume its result.
export function setMinimalAcpCommandRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      channel(
        "telegram",
        {
          "telegram:-1003841603622/498": {
            conversationId: "-1003841603622:topic:498",
            parentConversationId: "-1003841603622",
          },
          "telegram:123456789/": {
            conversationId: "123456789",
            parentConversationId: "123456789",
          },
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
              operation === "acp-spawn" &&
              conversation.conversationId === "-1003841603622:topic:498"
                ? { delivery: { pin: { enabled: true } } }
                : null,
          },
        },
      ),
      channel(
        "discord",
        {
          "channel:parent-1/": { conversationId: "channel:parent-1" },
          "channel:parent-1/thread-1": {
            conversationId: "thread-1",
            parentConversationId: "channel:parent-1",
          },
        },
        { conversationBindings: { defaultTopLevelPlacement: "child" } },
      ),
      channel("slack", { "user:U123/": { conversationId: "user:U123" } }, {}),
      channel("matrix", {}, { conversationBindings: { defaultTopLevelPlacement: "child" } }),
    ]),
  );
}
