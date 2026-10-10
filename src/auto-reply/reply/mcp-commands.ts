// Implements MCP server command parsing and persisted enablement settings.
import { parseSlashCommandWithSetUnset } from "./commands-setunset.js";

type McpCommand =
  | { action: "show"; name?: string }
  | { action: "set"; name: string; value: unknown }
  | { action: "unset"; name: string }
  | { action: "error"; message: string };

export function parseMcpCommand(raw: string): McpCommand | null {
  const parsed = parseSlashCommandWithSetUnset<Extract<McpCommand, { action: "show" }>>({
    raw,
    slash: "/mcp",
    usageMessage: "Usage: /mcp show|set|unset",
    onKnownAction: (action, args) => {
      if (action === "show" || action === "get") {
        return { action: "show", name: args || undefined };
      }
      return undefined;
    },
  });
  if (parsed?.action === "set") {
    return { action: "set", name: parsed.path, value: parsed.value };
  }
  if (parsed?.action === "unset") {
    return { action: "unset", name: parsed.path };
  }
  return parsed;
}
