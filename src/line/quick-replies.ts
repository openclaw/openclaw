import type { messagingApi } from "@line/bot-sdk";

type QuickReply = messagingApi.QuickReply;
type QuickReplyItem = messagingApi.QuickReplyItem;
type TextMessage = messagingApi.TextMessage;

export function createQuickReplyItems(labels: string[]): QuickReply {
  const items: QuickReplyItem[] = labels.slice(0, 13).map((label) => ({
    type: "action",
    action: {
      type: "message",
      label: label.slice(0, 20),
      text: label,
    },
  }));
  return { items };
}

export function createTextMessageWithQuickReplies(
  text: string,
  quickReplyLabels: string[],
): TextMessage & { quickReply: QuickReply } {
  return {
    type: "text",
    text,
    quickReply: createQuickReplyItems(quickReplyLabels),
  };
}
