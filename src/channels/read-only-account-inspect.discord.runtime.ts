import { inspectDiscordAccount as inspectDiscordAccountImpl } from "openclaw/plugin-sdk/discord";

export type { InspectedDiscordAccount } from "openclaw/plugin-sdk/discord";

type InspectDiscordAccount = typeof import("openclaw/plugin-sdk/discord").inspectDiscordAccount;

export function inspectDiscordAccount(
  ...args: Parameters<InspectDiscordAccount>
): ReturnType<InspectDiscordAccount> {
  return inspectDiscordAccountImpl(...args);
}
