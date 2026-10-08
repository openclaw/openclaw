import type { ConversationRef } from "../infra/outbound/session-binding-service.js";

export function sameConversationRef(a: ConversationRef, b: ConversationRef): boolean {
  // Telegram flat groups may omit a redundant self-parent that ingress includes.
  // The Telegram binding store omits an inferable topic parent on reload;
  // ingress still supplies it. Keep an explicitly wrong parent mismatched.
  const flatTelegramGroup = a.channel === "telegram" && /^-[0-9]+$/u.test(a.conversationId);
  const topicParent =
    a.channel === "telegram" ? /^(-100\d+):topic:\d+$/u.exec(a.conversationId)?.[1] : undefined;
  const aParent =
    flatTelegramGroup && a.parentConversationId === a.conversationId
      ? undefined
      : (a.parentConversationId ?? topicParent);
  const bParent =
    flatTelegramGroup && b.parentConversationId === b.conversationId
      ? undefined
      : (b.parentConversationId ?? topicParent);
  return (
    a.channel === b.channel &&
    a.accountId === b.accountId &&
    a.conversationId === b.conversationId &&
    aParent === bParent
  );
}

export function telegramConversationUrl(conversation: ConversationRef): string | undefined {
  if (conversation.channel !== "telegram") {
    return undefined;
  }
  const match = /^(-100\d+):topic:(\d+)$/u.exec(conversation.conversationId);
  if (!match) {
    return undefined;
  }
  return `https://t.me/c/${match[1]!.slice(4)}/${match[2]}`;
}
