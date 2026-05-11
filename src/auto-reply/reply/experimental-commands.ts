import { parseSlashCommandOrNull } from "./commands-slash-parse.js";
import { parseConfigValue } from "./config-value.js";

export type ExperimentalCommand =
  | { action: "list" }
  | { action: "set"; selector: string; value: boolean }
  | { action: "error"; message: string };

const USAGE = "Usage: /experimental list|on|off|set path=true|false";

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseSetAction(args: string): ExperimentalCommand {
  const eqIndex = args.indexOf("=");
  if (eqIndex <= 0) {
    return { action: "error", message: "Usage: /experimental set path=true|false" };
  }
  const selector = args.slice(0, eqIndex).trim();
  const rawValue = args.slice(eqIndex + 1);
  if (!selector) {
    return { action: "error", message: "Usage: /experimental set path=true|false" };
  }
  const parsed = parseConfigValue(rawValue);
  if (parsed.error) {
    return { action: "error", message: "Usage: /experimental set path=true|false" };
  }
  const value = parseBoolean(parsed.value);
  if (value === undefined) {
    return { action: "error", message: "Usage: /experimental set path=true|false" };
  }
  return { action: "set", selector, value };
}

function parseToggleAction(action: string, args: string): ExperimentalCommand {
  const selector = args.trim();
  if (!selector) {
    return { action: "error", message: USAGE };
  }
  return {
    action: "set",
    selector,
    value: action === "on" || action === "enable",
  };
}

export function parseExperimentalCommand(raw: string): ExperimentalCommand | null {
  const parsed = parseSlashCommandOrNull(raw, "/experimental", {
    invalidMessage: "Invalid /experimental syntax.",
    defaultAction: "list",
  });
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return { action: "error", message: parsed.message };
  }
  const { action, args } = parsed;
  if (action === "list" || action === "show" || action === "status") {
    return { action: "list" };
  }
  if (action === "set") {
    return parseSetAction(args);
  }
  if (action === "on" || action === "enable" || action === "off" || action === "disable") {
    return parseToggleAction(action, args);
  }
  return { action: "error", message: USAGE };
}
