import { parseConfigValue } from "./config-value.js";

export type DebugCommand =
  | { action: "show" }
  | { action: "reset" }
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

export function parseDebugCommand(raw: string): DebugCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("/debug")) return null;
  const rest = trimmed.slice("/debug".length).trim();
  if (!rest) return { action: "show" };

  const match = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!match) return { action: "error", message: "Invalid /debug syntax." };
  const action = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();

  switch (action) {
    case "show":
      return { action: "show" };
    case "reset":
      return { action: "reset" };
    case "unset": {
      if (!args) return { action: "error", message: "Usage: /debug unset path" };
      return { action: "unset", path: args };
    }
    case "set": {
      if (!args) {
        return {
          action: "error",
          message: "Usage: /debug set path=value",
        };
      }
      const eqIndex = args.indexOf("=");
      if (eqIndex <= 0) {
        return {
          action: "error",
          message: "Usage: /debug set path=value",
        };
      }
      const path = args.slice(0, eqIndex).trim();
      const rawValue = args.slice(eqIndex + 1);
      if (!path) {
        return {
          action: "error",
          message: "Usage: /debug set path=value",
        };
      }
      const parsed = parseConfigValue(rawValue);
      if (parsed.error) {
        return { action: "error", message: parsed.error };
      }
      return { action: "set", path, value: parsed.value };
    }
    default:
      return {
        action: "error",
        message: "Usage: /debug show|set|unset|reset",
      };
  }
}
