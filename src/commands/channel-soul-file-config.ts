import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

type Params = {
  channel: string;
  accountId: string;
};

const ACCOUNT_SCOPED_SOUL_CHANNELS = new Set([
  "discord",
  "discord-user",
  "feishu",
  "line",
  "slack",
  "telegram",
  "whatsapp",
]);

export function canWriteAccountScopedSoulFile({ channel, accountId }: Params): boolean {
  if (!ACCOUNT_SCOPED_SOUL_CHANNELS.has(channel)) {
    return false;
  }
  return Boolean(accountId && accountId.trim()) || accountId === DEFAULT_ACCOUNT_ID;
}
