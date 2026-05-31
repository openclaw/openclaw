import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeAgentPromptSurfaceKind } from "./agent-prompt-surface-kind.js";
import type {
  AgentPromptGuidance,
  AgentPromptSurfaceKind,
  OpenClawPluginCommandDefinition,
} from "./types.js";

export type RegisteredPluginCommand = OpenClawPluginCommandDefinition & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
  trustedOwnerStatusExposure?: true;
};

type PluginCommandState = {
  pluginCommands: Map<string, RegisteredPluginCommand>;
  registryLocked: boolean;
};

const PLUGIN_COMMAND_STATE_KEY = Symbol.for("openclaw.pluginCommandsState");

const getState = () =>
  resolveGlobalSingleton<PluginCommandState>(PLUGIN_COMMAND_STATE_KEY, () => ({
    pluginCommands: new Map<string, RegisteredPluginCommand>(),
    registryLocked: false,
  }));

const getPluginCommandMap = () => getState().pluginCommands;

/**
 * Process-wide command map shared across duplicate module instances in tests,
 * bundled plugin loaders, and SDK facades.
 */
export const pluginCommands = new Proxy(new Map<string, RegisteredPluginCommand>(), {
  get(_target, property) {
    const value = Reflect.get(getPluginCommandMap(), property, getPluginCommandMap());
    return typeof value === "function" ? value.bind(getPluginCommandMap()) : value;
  },
});

/**
 * Return whether command registration is frozen during command dispatch.
 */
export function isPluginCommandRegistryLocked(): boolean {
  return getState().registryLocked;
}

/**
 * Freeze or reopen registration around command dispatch.
 */
export function setPluginCommandRegistryLocked(locked: boolean): void {
  getState().registryLocked = locked;
}

/**
 * Remove all registered plugin commands from the shared process registry.
 */
export function clearPluginCommands(): void {
  pluginCommands.clear();
}

/**
 * Remove every command owned by one plugin id.
 */
export function clearPluginCommandsForPlugin(pluginId: string): void {
  for (const [key, cmd] of pluginCommands.entries()) {
    if (cmd.pluginId === pluginId) {
      pluginCommands.delete(key);
    }
  }
}

/**
 * Return whether a command is allowed to occupy a built-in command name.
 */
export function isTrustedReservedCommandOwner(command: RegisteredPluginCommand): boolean {
  return command.ownership === "reserved";
}

/**
 * Return whether command handlers may receive owner-status context.
 */
export function canExposeSenderIsOwner(command: RegisteredPluginCommand): boolean {
  return (
    (Array.isArray(command.requiredScopes) && command.requiredScopes.length > 0) ||
    command.trustedOwnerStatusExposure === true
  );
}

/**
 * Snapshot the currently registered plugin commands.
 */
export function listRegisteredPluginCommands(): RegisteredPluginCommand[] {
  return Array.from(pluginCommands.values());
}

/**
 * Gather deduped agent prompt guidance lines for the requested prompt surface.
 */
export function listRegisteredPluginAgentPromptGuidance(params?: {
  surface?: AgentPromptSurfaceKind;
  includeLegacyGlobalGuidance?: boolean;
}): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const command of pluginCommands.values()) {
    for (const entry of command.agentPromptGuidance ?? []) {
      const trimmed = resolveAgentPromptGuidanceTextForSurface(entry, {
        surface: params?.surface ? normalizeAgentPromptSurfaceKind(params.surface) : undefined,
        includeLegacyGlobalGuidance: params?.includeLegacyGlobalGuidance ?? true,
      });
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      lines.push(trimmed);
    }
  }
  return lines;
}

/**
 * Resolve legacy string guidance and surface-scoped object guidance consistently
 * for system prompts, compact prompts, and subagent prompt construction.
 */
function resolveAgentPromptGuidanceTextForSurface(
  entry: AgentPromptGuidance,
  params: {
    surface?: AgentPromptSurfaceKind;
    includeLegacyGlobalGuidance: boolean;
  },
): string | undefined {
  if (typeof entry === "string") {
    return params.includeLegacyGlobalGuidance ? entry.trim() : undefined;
  }
  const text = entry.text.trim();
  if (!params.surface) {
    return text;
  }
  if (!entry.surfaces || entry.surfaces.length === 0) {
    return params.includeLegacyGlobalGuidance ? text : undefined;
  }
  return entry.surfaces.includes(params.surface) ? text : undefined;
}

/**
 * Restore a previously captured command snapshot into the process registry.
 */
export function restorePluginCommands(commands: readonly RegisteredPluginCommand[]): void {
  pluginCommands.clear();
  for (const command of commands) {
    const name = normalizeOptionalLowercaseString(command.name);
    if (!name) {
      continue;
    }
    pluginCommands.set(`/${name}`, command);
  }
}
