import type { ChannelMessageActionName } from "./types.public.js";

const trustedRequesterChannelManagementActions = new Set<ChannelMessageActionName>([
  "emoji-upload",
  "sticker-upload",
  "role-add",
  "role-remove",
  "channel-create",
  "channel-edit",
  "channel-delete",
  "channel-move",
  "category-create",
  "category-edit",
  "category-delete",
  "event-create",
  "topic-create",
  "topic-edit",
  "timeout",
  "kick",
  "ban",
]);

export function isTrustedRequesterChannelManagementAction(
  action: ChannelMessageActionName,
): boolean {
  return trustedRequesterChannelManagementActions.has(action);
}
