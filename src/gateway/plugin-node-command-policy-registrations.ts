import type {
  PluginNodeHostCommandRegistration,
  PluginNodeInvokePolicyRegistration,
} from "../plugins/registry-types.js";
import type { OpenClawPluginNodeInvokePolicy } from "../plugins/types.js";

export type ReadablePluginNodeHostCommandRegistration = {
  pluginId: string;
  command: string;
  dangerous: boolean;
};

export type ReadablePluginNodeInvokePolicyRegistration = {
  pluginId: string;
  pluginConfig?: Record<string, unknown>;
  commands: string[];
  defaultPlatforms: string[];
  dangerous: boolean;
  foregroundRestrictedOnIos: boolean;
  handle: OpenClawPluginNodeInvokePolicy["handle"];
};

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readPluginId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function readPluginNodeHostCommandRegistration(
  entry: PluginNodeHostCommandRegistration,
): ReadablePluginNodeHostCommandRegistration | null {
  try {
    const pluginId = readPluginId(entry.pluginId);
    const command = entry.command;
    if (!pluginId || typeof command.command !== "string") {
      return null;
    }
    return {
      pluginId,
      command: command.command,
      dangerous: command.dangerous === true,
    };
  } catch {
    return null;
  }
}

export function readPluginNodeInvokePolicyRegistration(
  entry: PluginNodeInvokePolicyRegistration,
): ReadablePluginNodeInvokePolicyRegistration | null {
  try {
    const pluginId = readPluginId(entry.pluginId);
    const policy = entry.policy;
    if (!pluginId || typeof policy.handle !== "function") {
      return null;
    }
    return {
      pluginId,
      ...(entry.pluginConfig ? { pluginConfig: entry.pluginConfig } : {}),
      commands: readStringArray(policy.commands),
      defaultPlatforms: readStringArray(policy.defaultPlatforms),
      dangerous: policy.dangerous === true,
      foregroundRestrictedOnIos: policy.foregroundRestrictedOnIos === true,
      handle: policy.handle,
    };
  } catch {
    return null;
  }
}
