import type { Update } from "@grammyjs/types";

type TelegramUpdateType = Exclude<keyof Update, "update_id">;

/**
 * Returns the list of update types that the Telegram bot should receive.
 * 
 * IMPORTANT: We explicitly include ALL update types to ensure group messages
 * are received. The grammY DEFAULT_UPDATE_TYPES may not include all types.
 * 
 * See: https://core.telegram.org/bots/api#update
 */
export function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramUpdateType> {
  // Explicitly list ALL update types to ensure group messages are received
  // This includes: message, edited_message, channel_post, edited_channel_post,
  // inline_query, chosen_inline_result, callback_query, shipping_query,
  // pre_checkout_query, poll, poll_answer, my_chat_member, chat_member,
  // chat_join_request, message_reaction, message_reaction_count
  return [
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "inline_query",
    "chosen_inline_result",
    "callback_query",
    "shipping_query",
    "pre_checkout_query",
    "poll",
    "poll_answer",
    "my_chat_member",
    "chat_member",
    "chat_join_request",
    "message_reaction",
    "message_reaction_count",
  ] as TelegramUpdateType[];
}
