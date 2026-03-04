import { formatIMessageChatTarget } from "../targets.js";

/**
 * Build the echo-detection scope key used when **checking** an inbound message.
 *
 * For groups the scope is `{accountId}:chat_id:{chatId}`.
 * For DMs the scope is `{accountId}:imessage:{sender}`.
 */
export function buildIMessageEchoScope(params: {
  accountId: string;
  isGroup: boolean;
  chatId?: number;
  sender: string;
}): string {
  return `${params.accountId}:${params.isGroup ? formatIMessageChatTarget(params.chatId) : `imessage:${params.sender}`}`;
}

/**
 * Build the echo-detection scope key used when **remembering** a sent message.
 *
 * `target` is already formatted as `chat_id:{id}` (group) or `imessage:{handle}` (DM),
 * so the result matches `buildIMessageEchoScope` by construction.
 */
export function buildDeliveryEchoScope(accountId: string, target: string): string {
  return `${accountId}:${target}`;
}
