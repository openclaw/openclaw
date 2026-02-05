import type { Client } from "@larksuiteoapi/node-sdk";

/**
 * Reaction info returned from Feishu API
 */
export type FeishuReaction = {
  reactionId: string;
  emojiType: string;
  operatorType: "app" | "user";
  operatorId: string;
};

/**
 * Add a reaction (emoji) to a message.
 * @param emojiType - Feishu emoji type, e.g., "SMILE", "THUMBSUP", "HEART", "Typing"
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
 */
export async function addReactionFeishu(
  client: Client,
  messageId: string,
  emojiType: string,
): Promise<{ reactionId: string }> {
  const response = (await client.im.messageReaction.create({
    path: { message_id: messageId },
    data: {
      reaction_type: {
        emoji_type: emojiType,
      },
    },
  })) as {
    code?: number;
    msg?: string;
    data?: { reaction_id?: string };
  };

  if (response.code !== 0) {
    throw new Error(`Feishu add reaction failed: ${response.msg || `code ${response.code}`}`);
  }

  const reactionId = response.data?.reaction_id;
  if (!reactionId) {
    throw new Error("Feishu add reaction failed: no reaction_id returned");
  }

  return { reactionId };
}

/**
 * Remove a reaction from a message.
 */
export async function removeReactionFeishu(
  client: Client,
  messageId: string,
  reactionId: string,
): Promise<void> {
  const response = (await client.im.messageReaction.delete({
    path: {
      message_id: messageId,
      reaction_id: reactionId,
    },
  })) as { code?: number; msg?: string };

  if (response.code !== 0) {
    throw new Error(`Feishu remove reaction failed: ${response.msg || `code ${response.code}`}`);
  }
}

/**
 * List all reactions for a message.
 */
export async function listReactionsFeishu(
  client: Client,
  messageId: string,
  emojiType?: string,
): Promise<FeishuReaction[]> {
  const response = (await client.im.messageReaction.list({
    path: { message_id: messageId },
    params: emojiType ? { reaction_type: emojiType } : undefined,
  })) as {
    code?: number;
    msg?: string;
    data?: {
      items?: Array<{
        reaction_id?: string;
        reaction_type?: { emoji_type?: string };
        operator_type?: string;
        operator_id?: { open_id?: string; user_id?: string; union_id?: string };
      }>;
    };
  };

  if (response.code !== 0) {
    throw new Error(`Feishu list reactions failed: ${response.msg || `code ${response.code}`}`);
  }

  const items = response.data?.items ?? [];
  return items.map((item) => ({
    reactionId: item.reaction_id ?? "",
    emojiType: item.reaction_type?.emoji_type ?? "",
    operatorType: item.operator_type === "app" ? "app" : "user",
    operatorId:
      item.operator_id?.open_id ?? item.operator_id?.user_id ?? item.operator_id?.union_id ?? "",
  }));
}

/**
 * Common Feishu emoji types for convenience.
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
 */
export const FeishuEmoji = {
  // Common reactions
  THUMBSUP: "THUMBSUP",
  THUMBSDOWN: "THUMBSDOWN",
  HEART: "HEART",
  SMILE: "SMILE",
  GRINNING: "GRINNING",
  LAUGHING: "LAUGHING",
  CRY: "CRY",
  ANGRY: "ANGRY",
  SURPRISED: "SURPRISED",
  THINKING: "THINKING",
  CLAP: "CLAP",
  OK: "OK",
  FIST: "FIST",
  PRAY: "PRAY",
  FIRE: "FIRE",
  PARTY: "PARTY",
  CHECK: "CHECK",
  CROSS: "CROSS",
  QUESTION: "QUESTION",
  EXCLAMATION: "EXCLAMATION",
  // Special typing indicator
  TYPING: "Typing",
} as const;

export type FeishuEmojiType = (typeof FeishuEmoji)[keyof typeof FeishuEmoji];
