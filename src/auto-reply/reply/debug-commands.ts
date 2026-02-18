import { parseSetUnsetCommandAction } from "./commands-setunset.js";
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
  const setUnset = parseSetUnsetCommandAction<DebugCommand>({
    slash: "/debug",
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
      return { action: "show" };
    case "reset":
      return { action: "reset" };
    default:
      return {
        action: "error",
        message: "Usage: /debug show|set|unset|reset",
      };
  }
}
