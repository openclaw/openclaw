import { parseSetUnsetCommand } from "./commands-setunset.js";
import { parseSlashCommandOrNull } from "./commands-slash-parse.js";

export type DebugCommand =
  | { action: "show" }
  | { action: "reset" }
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

export function parseDebugCommand(raw: string): DebugCommand | null {
  const parsed = parseSlashCommandOrNull(raw, "/debug", {
    invalidMessage: "Invalid /debug syntax.",
  });
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return { action: "error", message: parsed.message };
  }
  const { action, args } = parsed;

  switch (action) {
    case "show":
      return { action: "show" };
    case "reset":
      return { action: "reset" };
    case "unset":
    case "set": {
      const parsed = parseSetUnsetCommand({ slash: "/debug", action, args });
      if (parsed.kind === "error") {
        return { action: "error", message: parsed.message };
      }
      return parsed.kind === "set"
        ? { action: "set", path: parsed.path, value: parsed.value }
        : { action: "unset", path: parsed.path };
    }
    default:
      return {
        action: "error",
        message: "Usage: /debug show|set|unset|reset",
      };
  }
}
