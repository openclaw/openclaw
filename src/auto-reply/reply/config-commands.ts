import { parseSetUnsetCommandAction } from "./commands-setunset.js";
import { parseSlashCommandOrNull } from "./commands-slash-parse.js";

export type ConfigCommand =
  | { action: "show"; path?: string }
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

export function parseConfigCommand(raw: string): ConfigCommand | null {
  const parsed = parseSlashCommandOrNull(raw, "/config", {
    invalidMessage: "Invalid /config syntax.",
  });
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return { action: "error", message: parsed.message };
  }
  const { action, args } = parsed;
  const setUnset = parseSetUnsetCommandAction<ConfigCommand>({
    slash: "/config",
    action,
    args,
    onSet: (path, value) => ({ action: "set", path, value }),
    onUnset: (path) => ({ action: "unset", path }),
    onError: (message) => ({ action: "error", message }),
  });
  if (setUnset) {
    return setUnset;
  }

  switch (action) {
    case "show":
      return { action: "show", path: args || undefined };
    case "get":
      return { action: "show", path: args || undefined };
    default:
      return {
        action: "error",
        message: "Usage: /config show|set|unset",
      };
  }
}
