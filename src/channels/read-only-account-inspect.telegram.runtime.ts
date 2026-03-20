import { inspectTelegramAccount as inspectTelegramAccountImpl } from "../../extensions/telegram/api.js";

export type { InspectedTelegramAccount } from "../../extensions/telegram/api.js";

type InspectTelegramAccount =
  typeof import("../../extensions/telegram/api.js").inspectTelegramAccount;

export function inspectTelegramAccount(
  ...args: Parameters<InspectTelegramAccount>
): ReturnType<InspectTelegramAccount> {
  return inspectTelegramAccountImpl(...args);
}
