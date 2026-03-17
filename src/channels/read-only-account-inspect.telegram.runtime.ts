import { inspectTelegramAccount as inspectTelegramAccountImpl } from "../plugin-sdk/telegram.js";

export type { InspectedTelegramAccount } from "../plugin-sdk/telegram.js";

type InspectTelegramAccount = typeof import("../plugin-sdk/telegram.js").inspectTelegramAccount;

export function inspectTelegramAccount(
  ...args: Parameters<InspectTelegramAccount>
): ReturnType<InspectTelegramAccount> {
  return inspectTelegramAccountImpl(...args);
}
