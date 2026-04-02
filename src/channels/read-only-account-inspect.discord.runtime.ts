import { inspectDiscordAccount as inspectDiscordAccountImpl } from "../plugin-sdk/discord-surface.js";

export type { InspectedDiscordAccount } from "../plugin-sdk/discord-surface.js";

type InspectDiscordAccount =
  typeof import("../plugin-sdk/discord-surface.js").inspectDiscordAccount;

export function inspectDiscordAccount(
  ...args: Parameters<InspectDiscordAccount>
): ReturnType<InspectDiscordAccount> {
  return inspectDiscordAccountImpl(...args);
}
