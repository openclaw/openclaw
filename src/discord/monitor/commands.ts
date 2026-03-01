import type { DiscordSlashCommandConfig } from "../../config/types.discord.js";

export function resolveDiscordSlashCommandConfig(
  raw?: DiscordSlashCommandConfig,
): Required<DiscordSlashCommandConfig> {
  return {
    ephemeral: raw?.ephemeral !== false,
  };
}
