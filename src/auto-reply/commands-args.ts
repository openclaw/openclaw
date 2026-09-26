/** Argument serializers for command definitions that expose structured values. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import type { CommandArgValues } from "./commands-registry.types.js";

type CommandArgsFormatter = (values: CommandArgValues) => string | undefined;

function normalizeArgValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  let text: string;
  if (typeof value === "string") {
    text = normalizeOptionalString(value) ?? "";
  } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    text = normalizeOptionalString(String(value)) ?? "";
  } else if (typeof value === "symbol") {
    text = normalizeOptionalString(value.toString()) ?? "";
  } else if (typeof value === "function") {
    text = normalizeOptionalString(value.toString()) ?? "";
  } else {
    // Objects and arrays are rare but preserve structured test values losslessly enough for text.
    text = JSON.stringify(value);
  }
  return text ? text : undefined;
}

function formatActionArgs(
  values: CommandArgValues,
  pathActions: readonly string[] = ["show", "get"],
): string | undefined {
  const action = normalizeOptionalLowercaseString(normalizeArgValue(values.action));
  const path = normalizeArgValue(values.path);
  const value = normalizeArgValue(values.value);
  if (!action) {
    return undefined;
  }
  if (action === "set" && path && value) {
    return `${action} ${path}=${value}`;
  }
  const includesPath = action === "set" || action === "unset" || pathActions.includes(action);
  return path && includesPath ? `${action} ${path}` : action;
}

function formatNamedArgs(
  values: CommandArgValues,
  names: readonly string[],
  separator: string,
  positional?: string,
): string | undefined {
  const parts: string[] = [];
  for (const name of names) {
    const value = normalizeArgValue(values[name]);
    if (value) {
      parts.push(name === positional ? value : `${name}${separator}${value}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Command-specific serializers used when rebuilding slash-command text from parsed args. */
export const COMMAND_ARG_FORMATTERS: Record<string, CommandArgsFormatter> = {
  config: formatActionArgs,
  mcp: formatActionArgs,
  plugins: (values) => formatActionArgs(values, ["show", "get", "enable", "disable"]),
  debug: (values) => formatActionArgs(values, []),
  queue: (values) => formatNamedArgs(values, ["mode", "debounce", "cap", "drop"], ":", "mode"),
  exec: (values) => formatNamedArgs(values, ["host", "security", "ask", "node"], "="),
};
