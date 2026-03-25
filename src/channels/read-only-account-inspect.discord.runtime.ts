import { inspectDiscordAccount as inspectDiscordAccountImpl } from "../../extensions/discord/api.js";

export type { InspectedDiscordAccount } from "../../extensions/discord/api.js";

type InspectDiscordAccount = typeof import("../../extensions/discord/api.js").inspectDiscordAccount;

export function inspectDiscordAccount(
  ...args: Parameters<InspectDiscordAccount>
): ReturnType<InspectDiscordAccount> {
  return inspectDiscordAccountImpl(...args);
}
