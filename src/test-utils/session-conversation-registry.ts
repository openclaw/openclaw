import { createTestRegistry } from "./channel-plugins.js";

function parseTelegramTopicConversation(rawId: string) {
  const match = /^(-?\d+):topic:(\d+)$/i.exec(rawId.trim());
  if (!match) {
    return null;
  }
  return {
    id: match[1],
    threadId: match[2],
    parentConversationCandidates: [match[1]],
  };
}

function resolveFeishuConversation(rawId: string) {
  const trimmed = rawId.trim();
  if (!trimmed) {
    return null;
  }
  const topicSenderMatch = /^(.+):topic:([^:]+):sender:([^:]+)$/i.exec(trimmed);
  if (topicSenderMatch) {
    const [, chatId, topicId, senderId] = topicSenderMatch;
    return {
      id: `${chatId}:topic:${topicId}:sender:${senderId}`,
      parentConversationCandidates: [`${chatId}:topic:${topicId}`, chatId],
    };
  }
  const topicMatch = /^(.+):topic:([^:]+)$/i.exec(trimmed);
  if (topicMatch) {
    const [, chatId, topicId] = topicMatch;
    return {
      id: `${chatId}:topic:${topicId}`,
      parentConversationCandidates: [chatId],
    };
  }
  const senderMatch = /^(.+):sender:([^:]+)$/i.exec(trimmed);
  if (senderMatch) {
    const [, chatId, senderId] = senderMatch;
    return {
      id: `${chatId}:sender:${senderId}`,
      parentConversationCandidates: [chatId],
    };
  }
  return {
    id: trimmed,
    parentConversationCandidates: [],
  };
}

export function createSessionConversationTestRegistry() {
  return createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: {
        id: "discord",
        meta: {
          id: "discord",
          label: "Discord",
          selectionLabel: "Discord",
          docsPath: "/channels/discord",
          blurb: "Discord test stub.",
        },
        capabilities: { chatTypes: ["direct", "channel", "thread"] },
        messaging: {
          resolveSessionTarget: ({ id }: { id: string }) => `channel:${id}`,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
    {
      pluginId: "slack",
      source: "test",
      plugin: {
        id: "slack",
        meta: {
          id: "slack",
          label: "Slack",
          selectionLabel: "Slack",
          docsPath: "/channels/slack",
          blurb: "Slack test stub.",
        },
        capabilities: { chatTypes: ["direct", "channel", "thread"] },
        messaging: {
          resolveSessionTarget: ({ id }: { id: string }) => `channel:${id}`,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
    {
      pluginId: "matrix",
      source: "test",
      plugin: {
        id: "matrix",
        meta: {
          id: "matrix",
          label: "Matrix",
          selectionLabel: "Matrix",
          docsPath: "/channels/matrix",
          blurb: "Matrix test stub.",
        },
        capabilities: { chatTypes: ["direct", "channel", "thread"] },
        messaging: {
          resolveSessionTarget: ({ id }: { id: string }) => `channel:${id}`,
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
    {
      pluginId: "telegram",
      source: "test",
      plugin: {
        id: "telegram",
        meta: {
          id: "telegram",
          label: "Telegram",
          selectionLabel: "Telegram",
          docsPath: "/channels/telegram",
          blurb: "Telegram test stub.",
        },
        capabilities: { chatTypes: ["direct", "group", "thread"] },
        messaging: {
          normalizeTarget: (raw: string) => raw.replace(/^group:/, ""),
          resolveSessionConversation: ({ rawId }: { rawId: string }) =>
            parseTelegramTopicConversation(rawId),
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
    {
      pluginId: "feishu",
      source: "test",
      plugin: {
        id: "feishu",
        meta: {
          id: "feishu",
          label: "Feishu",
          selectionLabel: "Feishu",
          docsPath: "/channels/feishu",
          blurb: "Feishu test stub.",
        },
        capabilities: { chatTypes: ["direct", "group", "thread"] },
        messaging: {
          normalizeTarget: (raw: string) => raw.replace(/^group:/, ""),
          resolveSessionConversation: ({ rawId }: { rawId: string }) =>
            resolveFeishuConversation(rawId),
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
      },
    },
  ]);
}
