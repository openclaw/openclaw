import { inspectTelegramAccount as inspectTelegramAccountImpl } from "../plugin-sdk/telegram-runtime.js";

export type { InspectedTelegramAccount } from "../plugin-sdk/telegram-runtime.js";

type InspectTelegramAccount =
  typeof import("../plugin-sdk/telegram-runtime.js").inspectTelegramAccount;

export function inspectTelegramAccount(
  ...args: Parameters<InspectTelegramAccount>
): ReturnType<InspectTelegramAccount> {
  return inspectTelegramAccountImpl(...args);
}
