import type { CommandArgValues } from "./commands-registry.types.js";

export type CommandArgsFormatter = (values: CommandArgValues) => string | undefined;

function normalizeArgValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  let text: string;
  if (typeof value === "string") {
    text = value.trim();
  } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    text = String(value).trim();
  } else if (typeof value === "symbol") {
    text = value.toString().trim();
  } else if (typeof value === "function") {
    text = value.toString().trim();
  } else {
    // Objects and arrays
    text = JSON.stringify(value);
  }
  return text ? text : undefined;
}

const formatConfigArgs: CommandArgsFormatter = (values) => {
  const action = normalizeArgValue(values.action)?.toLowerCase();
  const path = normalizeArgValue(values.path);
  const value = normalizeArgValue(values.value);
  if (!action) {
    return undefined;
  }
  const rest = formatSetUnsetArgAction(action, { path, value });
  if (action === "show" || action === "get") {
    return path ? `${action} ${path}` : action;
  }
  return rest;
};

const formatDebugArgs: CommandArgsFormatter = (values) => {
  const action = normalizeArgValue(values.action)?.toLowerCase();
  const path = normalizeArgValue(values.path);
  const value = normalizeArgValue(values.value);
  if (!action) {
    return undefined;
  }
  const rest = formatSetUnsetArgAction(action, { path, value });
  if (action === "show" || action === "reset") {
    return action;
  }
  return rest;
};

function formatSetUnsetArgAction(
  action: string,
  params: { path: string | undefined; value: string | undefined },
): string {
  if (action === "unset") {
    return params.path ? `${action} ${params.path}` : action;
  }
  if (action === "set") {
    if (!params.path) {
      return action;
    }
    if (!params.value) {
      return `${action} ${params.path}`;
    }
    return `${action} ${params.path}=${params.value}`;
  }
  return action;
}

const formatQueueArgs: CommandArgsFormatter = (values) => {
  const mode = normalizeArgValue(values.mode);
  const debounce = normalizeArgValue(values.debounce);
  const cap = normalizeArgValue(values.cap);
  const drop = normalizeArgValue(values.drop);
  const parts: string[] = [];
  if (mode) {
    parts.push(mode);
  }
  if (debounce) {
    parts.push(`debounce:${debounce}`);
  }
  if (cap) {
    parts.push(`cap:${cap}`);
  }
  if (drop) {
    parts.push(`drop:${drop}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
};

export const COMMAND_ARG_FORMATTERS: Record<string, CommandArgsFormatter> = {
  config: formatConfigArgs,
  debug: formatDebugArgs,
  queue: formatQueueArgs,
};
