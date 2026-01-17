export const CHANNEL_TARGET_DESCRIPTION =
  "Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack channel/user, or iMessage handle/chat_id";

export const CHANNEL_TARGETS_DESCRIPTION =
  "Recipient/channel targets (same format as --to); accepts ids or names when the directory is available.";

export function normalizeChannelTargetInput(raw: string): string {
  return raw.trim();
}
