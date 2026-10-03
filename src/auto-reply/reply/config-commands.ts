import { parseSlashCommandWithSetUnset, type SetUnsetCommand } from "./commands-setunset.js";

type ConfigCommand = { action: "show"; path?: string } | SetUnsetCommand;

export function parseConfigCommand(raw: string): ConfigCommand | null {
  return parseSlashCommandWithSetUnset<ConfigCommand>({
    raw,
    slash: "/config",
    usageMessage: "Usage: /config show|set|unset",
    onKnownAction: (action, args) => {
      if (action === "show" || action === "get") {
        return { action: "show", path: args || undefined };
      }
      return undefined;
    },
  });
}
