import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

function parseTelegramChatIdForTest(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^telegram:/i, "");
  if (!trimmed) {
    return undefined;
  }
  const topicMatch = /^(.*):topic:\d+$/i.exec(trimmed);
  return (topicMatch?.[1] ?? trimmed).trim() || undefined;
}

function parseDiscordConversationIdForTest(
  targets: Array<string | undefined | null>,
): string | undefined {
  for (const rawTarget of targets) {
    const target = rawTarget?.trim();
    if (!target) {
      continue;
    }
    const mentionMatch = /^<#(\d+)>$/.exec(target);
    if (mentionMatch?.[1]) {
      return mentionMatch[1];
    }
    if (/^channel:/i.test(target)) {
      return target;
    }
  }
  return undefined;
}

function parseDiscordParentChannelFromSessionKeyForTest(raw?: string | null): string | undefined {
  const sessionKey = raw?.trim().toLowerCase() ?? "";
  const match = sessionKey.match(/(?:^|:)channel:([^:]+)$/);
  return match?.[1] ? `channel:${match[1]}` : undefined;
}

export function setMinimalAcpCommandRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          conversationBindings: {
            defaultTopLevelPlacement: "current",
            buildBoundReplyPayload: ({
              operation,
              conversation,
            }: {
              operation: "acp-spawn";
              conversation: { conversationId: string };
            }) =>
              operation === "acp-spawn" && conversation.conversationId.includes(":topic:")
                ? { delivery: { pin: { enabled: true } } }
                : null,
          },
          bindings: {
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const chatId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => parseTelegramChatIdForTest(candidate))
                .find(Boolean);
              if (!chatId) {
                return null;
              }
              if (threadId) {
                return {
                  conversationId: `${chatId}:topic:${threadId}`,
                  parentConversationId: chatId,
                };
              }
              if (chatId.startsWith("-")) {
                return null;
              }
              return { conversationId: chatId, parentConversationId: chatId };
            },
          },
        },
      },
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "discord", label: "Discord" }),
          conversationBindings: {
            defaultTopLevelPlacement: "child",
          },
          bindings: {
            resolveCommandConversation: ({
              threadId,
              threadParentId,
              parentSessionKey,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              threadParentId?: string;
              parentSessionKey?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              if (threadId) {
                const parentConversationId =
                  (threadParentId?.trim()
                    ? `channel:${threadParentId.trim().replace(/^channel:/i, "")}`
                    : undefined) ??
                  parseDiscordParentChannelFromSessionKeyForTest(parentSessionKey) ??
                  parseDiscordConversationIdForTest([originatingTo, commandTo, fallbackTo]);
                return {
                  conversationId: threadId,
                  ...(parentConversationId && parentConversationId !== threadId
                    ? { parentConversationId }
                    : {}),
                };
              }
              const conversationId = parseDiscordConversationIdForTest([
                originatingTo,
                commandTo,
                fallbackTo,
              ]);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim())
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
          conversationBindings: {
            defaultTopLevelPlacement: "child",
          },
          bindings: {
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const roomId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim().replace(/^room:/i, ""))
                .find((candidate) => candidate && candidate.length > 0);
              if (!threadId || !roomId) {
                return null;
              }
              return {
                conversationId: threadId,
                parentConversationId: roomId,
              };
            },
          },
        },
      },
    ]),
  );
}
