import { parseConfigValue } from "./config-value.js";

export type SetUnsetParseResult =
  | { kind: "set"; path: string; value: unknown }
  | { kind: "unset"; path: string }
  | { kind: "error"; message: string };

export function parseSetUnsetCommand(params: {
  slash: string;
  action: "set" | "unset";
  args: string;
}): SetUnsetParseResult {
  const action = params.action;
  const args = params.args.trim();
  if (action === "unset") {
    if (!args) {
      return { kind: "error", message: `Usage: ${params.slash} unset path` };
    }
    return { kind: "unset", path: args };
  }
  if (!args) {
    return { kind: "error", message: `Usage: ${params.slash} set path=value` };
  }
  const eqIndex = args.indexOf("=");
  if (eqIndex <= 0) {
    return { kind: "error", message: `Usage: ${params.slash} set path=value` };
  }
  const path = args.slice(0, eqIndex).trim();
  const rawValue = args.slice(eqIndex + 1);
  if (!path) {
    return { kind: "error", message: `Usage: ${params.slash} set path=value` };
  }
  const parsed = parseConfigValue(rawValue);
  if (parsed.error) {
    return { kind: "error", message: parsed.error };
  }
  return { kind: "set", path, value: parsed.value };
}

export function parseSetUnsetCommandAction<T>(params: {
  slash: string;
  action: string;
  args: string;
  onSet: (path: string, value: unknown) => T;
  onUnset: (path: string) => T;
  onError: (message: string) => T;
}): T | null {
  if (params.action !== "set" && params.action !== "unset") {
    return null;
  }
  const parsed = parseSetUnsetCommand({
    slash: params.slash,
    action: params.action,
    args: params.args,
  });
  if (parsed.kind === "error") {
    return params.onError(parsed.message);
  }
  return parsed.kind === "set"
    ? params.onSet(parsed.path, parsed.value)
    : params.onUnset(parsed.path);
}
