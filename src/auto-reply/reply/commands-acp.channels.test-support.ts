import type { ChannelCommandConversationContext } from "../../channels/plugins/types.adapters.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

function commandTargets({
  originatingTo,
  commandTo,
  fallbackTo,
}: ChannelCommandConversationContext) {
  return [originatingTo, commandTo, fallbackTo];
}

function channel<T extends object>(id: string, label: string, plugin: T) {
  return {
    pluginId: id,
    source: "test",
    plugin: { ...createChannelTestPluginBase({ id, label }), ...plugin },
  };
}

function parseTelegramChatIdForTest(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^telegram:/i, "");
  const topicMatch = /^(.*):topic:\d+$/i.exec(trimmed ?? "");
  return (topicMatch?.[1] ?? trimmed)?.trim() || undefined;
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
      channel("telegram", "Telegram", {
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
          resolveCommandConversation: (params: ChannelCommandConversationContext) => {
            const { threadId } = params;
            const chatId = commandTargets(params).map(parseTelegramChatIdForTest).find(Boolean);
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
      }),
      channel("discord", "Discord", {
        conversationBindings: {
          defaultTopLevelPlacement: "child",
        },
        bindings: {
          resolveCommandConversation: (params: ChannelCommandConversationContext) => {
            const { threadId, threadParentId, parentSessionKey } = params;
            if (threadId) {
              const parentConversationId =
                (threadParentId?.trim()
                  ? `channel:${threadParentId.trim().replace(/^channel:/i, "")}`
                  : undefined) ??
                parseDiscordParentChannelFromSessionKeyForTest(parentSessionKey) ??
                parseDiscordConversationIdForTest(commandTargets(params));
              return {
                conversationId: threadId,
                ...(parentConversationId && parentConversationId !== threadId
                  ? { parentConversationId }
                  : {}),
              };
            }
            const conversationId = parseDiscordConversationIdForTest(commandTargets(params));
            return conversationId ? { conversationId } : null;
          },
        },
      }),
      channel("slack", "Slack", {
        bindings: {
          resolveCommandConversation: (params: ChannelCommandConversationContext) => {
            const conversationId = commandTargets(params)
              .map((candidate) => candidate?.trim())
              .find((candidate) => candidate && candidate.length > 0);
            return conversationId ? { conversationId } : null;
          },
        },
      }),
      channel("matrix", "Matrix", {
        conversationBindings: {
          defaultTopLevelPlacement: "child",
        },
        bindings: {
          resolveCommandConversation: (params: ChannelCommandConversationContext) => {
            const { threadId } = params;
            const roomId = commandTargets(params)
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
      }),
    ]),
  );
}
