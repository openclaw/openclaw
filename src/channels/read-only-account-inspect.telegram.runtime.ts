import { inspectTelegramAccount as inspectTelegramAccountImpl } from "openclaw/plugin-sdk/telegram";

export type { InspectedTelegramAccount } from "openclaw/plugin-sdk/telegram";

type InspectTelegramAccount = typeof import("openclaw/plugin-sdk/telegram").inspectTelegramAccount;

export function inspectTelegramAccount(
  ...args: Parameters<InspectTelegramAccount>
): ReturnType<InspectTelegramAccount> {
  return inspectTelegramAccountImpl(...args);
}
