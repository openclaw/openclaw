/** Shared parsing helpers for commands with set/unset subcommands. */
import { parseSlashCommandOrNull } from "./commands-slash-parse.js";
import { parseConfigValue } from "./config-value.js";

export type SetUnsetCommand =
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

/** Parses a slash command whose actions include set/unset plus custom actions. */
export function parseSlashCommandWithSetUnset<T>(params: {
  raw: string;
  slash: string;
  usageMessage: string;
  onKnownAction: (action: string, args: string) => T | undefined;
}): T | SetUnsetCommand | null {
  const parsed = parseSlashCommandOrNull(params.raw, params.slash);
  if (!parsed) {
    return null;
  }
  const error = (message: string): SetUnsetCommand => ({ action: "error", message });
  const { action } = parsed;
  const args = parsed.args.trim();
  if (action === "unset") {
    return args ? { action: "unset", path: args } : error(`Usage: ${params.slash} unset path`);
  }
  if (action === "set") {
    const equalsIndex = args.indexOf("=");
    const path = equalsIndex > 0 ? args.slice(0, equalsIndex).trim() : "";
    if (!path) {
      return error(`Usage: ${params.slash} set path=value`);
    }
    const value = parseConfigValue(args.slice(equalsIndex + 1));
    return value.error ? error(value.error) : { action: "set", path, value: value.value };
  }
  const knownAction = params.onKnownAction(action, args);
  if (knownAction) {
    return knownAction;
  }
  return error(params.usageMessage);
}
