import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

const ACCOUNT_SCOPED_SOUL_FILE_CHANNELS = new Set([
  "discord",
  "imessage",
  "signal",
  "slack",
  "telegram",
  "whatsapp",
]);

export function supportsAccountScopedSoulFile(channel: string): boolean {
  return ACCOUNT_SCOPED_SOUL_FILE_CHANNELS.has(channel);
}

export function canWriteAccountScopedSoulFile(params: {
  channel: string;
  accountId?: string | null;
}): boolean {
  const accountId = normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID;
  if (!supportsAccountScopedSoulFile(params.channel)) {
    return false;
  }
  return Boolean(accountId);
}
