import { inspectDiscordAccount as inspectDiscordAccountImpl } from "../plugin-sdk/discord.js";

export type { InspectedDiscordAccount } from "../plugin-sdk/discord.js";

type InspectDiscordAccount = typeof import("../plugin-sdk/discord.js").inspectDiscordAccount;

export function inspectDiscordAccount(
  ...args: Parameters<InspectDiscordAccount>
): ReturnType<InspectDiscordAccount> {
  return inspectDiscordAccountImpl(...args);
}
