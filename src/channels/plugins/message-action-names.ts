import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/**
 * Deliberately closed, core-owned vocabulary so every transport can render every action.
 * Plugins add names through a core PR; runtime registration is intentionally unsupported.
 */
export const CHANNEL_MESSAGE_ACTION_NAMES = [
  "send",
  "broadcast",
  "poll",
  "poll-vote",
  "react",
  "reactions",
  "read",
  "edit",
  "unsend",
  "reply",
  "sendWithEffect",
  "renameGroup",
  "setGroupIcon",
  "addParticipant",
  "removeParticipant",
  "leaveGroup",
  "sendAttachment",
  "delete",
  "pin",
  "unpin",
  "list-pins",
  "permissions",
  "thread-create",
  "thread-list",
  "thread-reply",
  "search",
  "sticker",
  "sticker-search",
  "dice",
  "member-info",
  "role-info",
  "emoji-list",
  "emoji-upload",
  "sticker-upload",
  "role-add",
  "role-remove",
  "channel-info",
  "channel-list",
  "channel-create",
  "conversation-open",
  "channel-edit",
  "channel-delete",
  "channel-move",
  "category-create",
  "category-edit",
  "category-delete",
  "topic-create",
  "topic-edit",
  "voice-status",
  "event-list",
  "event-create",
  "timeout",
  "kick",
  "ban",
  "set-profile",
  "set-presence",
  "download-file",
  "upload-file",
] as const;

/**
 * Message action name union derived from the canonical action list.
 */
export type ChannelMessageActionName = (typeof CHANNEL_MESSAGE_ACTION_NAMES)[number];

const MESSAGE_TOOL_SEND_ACTIONS = new Set([
  "send",
  "thread-reply",
  "sendWithEffect",
  "sendAttachment",
  "upload-file",
]);

/** Return true when a message action sends or uploads user-visible content. */
export function isMessageToolSendActionName(action: unknown): boolean {
  const normalized = normalizeOptionalString(action) ?? "";
  return MESSAGE_TOOL_SEND_ACTIONS.has(normalized);
}
