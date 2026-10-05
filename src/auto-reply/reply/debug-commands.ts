import { parseSlashCommandWithSetUnset, type SetUnsetCommand } from "./commands-setunset.js";

type DebugCommand = { action: "show" } | { action: "reset" } | SetUnsetCommand;

export function parseDebugCommand(raw: string): DebugCommand | null {
  return parseSlashCommandWithSetUnset<DebugCommand>({
    raw,
    slash: "/debug",
    usageMessage: "Usage: /debug show|set|unset|reset",
    onKnownAction: (action) => {
      if (action === "show" || action === "reset") {
        return { action };
      }
      return undefined;
    },
  });
}
