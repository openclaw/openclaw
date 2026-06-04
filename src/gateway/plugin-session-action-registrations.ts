import type { PluginSessionActionRegistryRegistration } from "../plugins/registry-types.js";
import { isOperatorScope, WRITE_SCOPE, type OperatorScope } from "./operator-scopes.js";

export type ReadablePluginSessionActionRegistration = {
  registration: PluginSessionActionRegistryRegistration;
  requiredScopes: OperatorScope[];
};

function readObjectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    const field = (value as Record<string, unknown>)[key];
    return field && typeof field === "object" && !Array.isArray(field)
      ? (field as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : undefined;
  } catch {
    return undefined;
  }
}

function readRequiredScopes(action: unknown): OperatorScope[] | undefined {
  if (!action || typeof action !== "object") {
    return undefined;
  }
  let rawScopes: unknown;
  try {
    rawScopes = (action as Record<string, unknown>).requiredScopes;
  } catch {
    return undefined;
  }
  if (rawScopes === undefined) {
    return [WRITE_SCOPE];
  }
  if (!Array.isArray(rawScopes)) {
    return undefined;
  }
  const scopes: OperatorScope[] = [];
  for (let index = 0; index < rawScopes.length; index += 1) {
    if (!Object.hasOwn(rawScopes, index)) {
      continue;
    }
    const scope = rawScopes[index];
    if (!isOperatorScope(scope)) {
      return undefined;
    }
    scopes.push(scope);
  }
  return scopes.length > 0 ? scopes : [WRITE_SCOPE];
}

function readEntry(entries: readonly unknown[], index: number): unknown {
  try {
    return entries[index];
  } catch {
    return undefined;
  }
}

/** Finds a readable plugin session action row without trusting plugin-owned accessors. */
export function findReadablePluginSessionActionRegistration(params: {
  registrations: unknown;
  pluginId: string;
  actionId: string;
}): ReadablePluginSessionActionRegistration | undefined {
  const entries = params.registrations;
  if (!Array.isArray(entries)) {
    return undefined;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = readEntry(entries, index);
    if (readStringField(entry, "pluginId") !== params.pluginId) {
      continue;
    }
    const action = readObjectField(entry, "action");
    if (readStringField(action, "id") !== params.actionId) {
      continue;
    }
    const requiredScopes = readRequiredScopes(action);
    if (!requiredScopes) {
      continue;
    }
    return {
      registration: entry as PluginSessionActionRegistryRegistration,
      requiredScopes,
    };
  }
  return undefined;
}
