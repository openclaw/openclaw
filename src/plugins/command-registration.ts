import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { isOperatorScope } from "../gateway/operator-scopes.js";
import { logVerbose } from "../globals.js";
import { isRecord } from "../utils.js";
import { normalizeAgentPromptSurfaceKind } from "./agent-prompt-surface-kind.js";
import { getPluginCommandExecutionCount } from "./command-execution-lock.js";
import { clearPluginCommands } from "./command-registry-state.js";
import { wrapCurrentPluginInstance } from "./plugin-instance-scope.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRegistrationContext, requireActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import {
  AGENT_PROMPT_SURFACE_KINDS,
  type AgentPromptGuidance,
  type AgentPromptGuidanceEntry,
  type AgentPromptSurfaceKind,
  type OpenClawPluginCommandDefinition,
} from "./types.js";

/**
 * Reserved command names that plugins cannot override (built-in commands).
 *
 * Constructed lazily inside validateCommandName to avoid TDZ errors: the
 * bundler can place this module's body after call sites within the same
 * output chunk, so any module-level const/let would be uninitialized when
 * first accessed during plugin registration.
 */
let reservedCommands: Set<string> | undefined;
let agentPromptSurfaces: Set<string> | undefined;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validateNonemptyString(value: unknown, label: string): string | null {
  if (typeof value !== "string") {
    return `${label} must be a string`;
  }
  return value.trim() ? null : `${label} cannot be empty`;
}

function getReservedCommands(): Set<string> {
  reservedCommands ??= new Set([
    "help",
    "commands",
    "status",
    "diagnostics",
    "codex",
    "whoami",
    "context",
    "btw",
    "stop",
    "restart",
    "reset",
    "new",
    "compact",
    "config",
    "debug",
    "allowlist",
    "activation",
    "skill",
    "learn",
    "loop",
    "subagents",
    "kill",
    "steer",
    "tell",
    "model",
    "models",
    "queue",
    "send",
    "bash",
    "exec",
    "think",
    "verbose",
    "reasoning",
    "elevated",
    "usage",
  ]);
  return reservedCommands;
}

type CommandRegistrationResult = {
  ok: boolean;
  error?: string;
};

export function isReservedCommandName(name: string): boolean {
  const trimmed = normalizeOptionalLowercaseString(name) ?? "";
  return Boolean(trimmed && getReservedCommands().has(trimmed));
}

function validateCommandName(
  name: string,
  opts?: { allowReservedCommandNames?: boolean },
): string | null {
  const trimmed = normalizeOptionalLowercaseString(name) ?? "";

  if (!trimmed) {
    return "Command name cannot be empty";
  }

  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
  }

  if (!opts?.allowReservedCommandNames && getReservedCommands().has(trimmed)) {
    return `Command name "${trimmed}" is reserved by a built-in command`;
  }

  return null;
}

function validatePluginCommandDefinition(
  command: OpenClawPluginCommandDefinition,
  opts?: { allowReservedCommandNames?: boolean },
): string | null {
  if (typeof command.handler !== "function") {
    return "Command handler must be a function";
  }
  if (typeof command.name !== "string") {
    return "Command name must be a string";
  }
  const descriptionError = validateNonemptyString(command.description, "Command description");
  if (descriptionError) {
    return descriptionError;
  }
  if (command.agentPromptGuidance !== undefined && !Array.isArray(command.agentPromptGuidance)) {
    return "Agent prompt guidance must be an array of strings or objects";
  }
  for (const [index, guidance] of (command.agentPromptGuidance ?? []).entries()) {
    const guidanceError = validateAgentPromptGuidance(index, guidance);
    if (guidanceError) {
      return guidanceError;
    }
  }
  if (command.requiredScopes !== undefined) {
    if (!Array.isArray(command.requiredScopes)) {
      return "Command requiredScopes must be an array of operator scopes";
    }
    const unknownScopeIndex = (command.requiredScopes as readonly unknown[]).findIndex(
      (scope) => !isOperatorScope(scope),
    );
    if (unknownScopeIndex !== -1) {
      const unknownScope: unknown = command.requiredScopes[unknownScopeIndex];
      return typeof unknownScope === "string"
        ? `Command requiredScopes contains unknown operator scope: ${unknownScope}`
        : "Command requiredScopes contains unknown operator scope";
    }
  }
  if (command.clientPresentation !== undefined) {
    if (!isRecord(command.clientPresentation)) {
      return "Command clientPresentation must be an object";
    }
    if (!hasExactKeys(command.clientPresentation, ["when", "action"])) {
      return "Command clientPresentation must contain only when and action";
    }
    if (command.clientPresentation.when !== "no-arguments") {
      return 'Command clientPresentation when must be "no-arguments"';
    }
    if (!isRecord(command.clientPresentation.action)) {
      return "Command clientPresentation action must be an object";
    }
    if (!hasExactKeys(command.clientPresentation.action, ["kind"])) {
      return "Command clientPresentation action must contain only kind";
    }
    if (command.clientPresentation.action.kind !== "device-pairing") {
      return "Command clientPresentation action kind is not supported";
    }
  }
  if (
    command.exposeSenderIsOwner !== undefined &&
    typeof command.exposeSenderIsOwner !== "boolean"
  ) {
    return "Command exposeSenderIsOwner must be a boolean";
  }
  if (command.channels !== undefined) {
    if (!Array.isArray(command.channels)) {
      return "Command channels must be an array of channel ids";
    }
    for (const [index, channel] of (command.channels as readonly unknown[]).entries()) {
      const error = validateNonemptyString(channel, `Command channel ${index + 1}`);
      if (error) {
        return error;
      }
    }
  }
  const nameError = validateCommandName(command.name, opts);
  if (nameError) {
    return nameError;
  }
  if (command.nativeNames !== undefined && !isRecord(command.nativeNames)) {
    return "Command nativeNames must be an object";
  }
  for (const [label, alias] of Object.entries(command.nativeNames ?? {})) {
    if (typeof alias !== "string") {
      continue;
    }
    const aliasError = validateCommandName(alias);
    if (aliasError) {
      return `Native command alias "${label}" invalid: ${aliasError}`;
    }
  }
  for (const [property, label] of [
    ["nativeProgressMessages", "Native progress message"],
    ["descriptionLocalizations", "Description localization"],
  ] as const) {
    const values = command[property];
    if (values !== undefined && !isRecord(values)) {
      return `Command ${property} must be an object`;
    }
    for (const [key, value] of Object.entries(values ?? {})) {
      const error = validateNonemptyString(value, `${label} "${key}"`);
      if (error) {
        return error;
      }
    }
  }
  return null;
}

function validateAgentPromptGuidance(index: number, guidance: AgentPromptGuidance): string | null {
  const label = `Agent prompt guidance ${index + 1}`;
  if (typeof guidance === "string") {
    return guidance.trim() ? null : `${label} cannot be empty`;
  }
  if (!isRecord(guidance)) {
    return `${label} must be a string or object`;
  }
  const textError = validateNonemptyString(guidance.text, `${label} text`);
  if (textError) {
    return textError;
  }
  if (guidance.surfaces === undefined) {
    return null;
  }
  if (!Array.isArray(guidance.surfaces)) {
    return `${label} surfaces must be an array of prompt surface ids`;
  }
  if (guidance.surfaces.length === 0) {
    return `${label} surfaces cannot be empty`;
  }
  for (const [surfaceIndex, surface] of guidance.surfaces.entries()) {
    const normalizedSurface = typeof surface === "string" ? surface.trim() : "";
    if (!(agentPromptSurfaces ??= new Set(AGENT_PROMPT_SURFACE_KINDS)).has(normalizedSurface)) {
      const surfaces = AGENT_PROMPT_SURFACE_KINDS.join(", ");
      return `${label} surface ${surfaceIndex + 1} must be one of: ${surfaces}`;
    }
  }
  return null;
}

function normalizeAgentPromptGuidance(
  guidance: readonly AgentPromptGuidance[],
): AgentPromptGuidance[] {
  return guidance.map((entry) => {
    if (typeof entry === "string") {
      return entry.trim();
    }
    const normalized: AgentPromptGuidanceEntry = {
      text: entry.text.trim(),
    };
    if (entry.surfaces) {
      normalized.surfaces = entry.surfaces.map((surface) =>
        normalizeAgentPromptSurfaceKind(surface.trim() as AgentPromptSurfaceKind),
      );
    }
    return normalized;
  });
}

function listPluginInvocationKeys(command: OpenClawPluginCommandDefinition): string[] {
  const names = [command.name, ...Object.values(command.nativeNames ?? {})];
  const keys = names.flatMap((name) => {
    const normalized = normalizeOptionalLowercaseString(name);
    return normalized ? [`/${normalized}`] : [];
  });
  return [...new Set(keys)];
}

export function registerPluginCommand(
  pluginId: string,
  command: OpenClawPluginCommandDefinition,
  opts?: {
    pluginName?: string;
    pluginRoot?: string;
    allowReservedCommandNames?: boolean;
    allowOwnerStatusExposure?: boolean;
  },
): CommandRegistrationResult {
  const context = getPluginRegistrationContext();
  return registerPluginCommandInRegistry(
    context?.registry ?? requireActivePluginRegistry(),
    context?.pluginId ?? pluginId,
    command,
    opts,
  );
}

export function registerPluginCommandInRegistry(
  registry: PluginRegistry,
  pluginId: string,
  command: OpenClawPluginCommandDefinition,
  opts?: Parameters<typeof registerPluginCommand>[2],
): CommandRegistrationResult {
  if (getPluginCommandExecutionCount(registry) > 0) {
    return { ok: false, error: "Cannot register commands while processing is in progress" };
  }
  if (command.ownership === "reserved") {
    return {
      ok: false,
      error: "Reserved command ownership is only available to bundled reserved commands",
    };
  }

  const definitionError = validatePluginCommandDefinition(command, opts);
  if (definitionError) {
    return { ok: false, error: definitionError };
  }

  const name = command.name.trim();
  const normalizedName = normalizeLowercaseStringOrEmpty(name);
  const description = command.description.trim();
  const normalizedCommand = {
    ...command,
    // The direct SDK registrar also supports host callers outside a managed instance.
    handler: wrapCurrentPluginInstance(
      command.handler,
      (handler) => (ctx) => withPluginRuntimeRegistryScope(registry, () => handler(ctx)),
    ),
    name,
    description,
    ...(command.channels
      ? { channels: command.channels.map((channel) => normalizeLowercaseStringOrEmpty(channel)) }
      : {}),
    ...(command.agentPromptGuidance
      ? { agentPromptGuidance: normalizeAgentPromptGuidance(command.agentPromptGuidance) }
      : {}),
    ...(command.clientPresentation
      ? {
          clientPresentation: {
            when: "no-arguments" as const,
            action: { kind: "device-pairing" as const },
          },
        }
      : {}),
  };
  const invocationKeys = listPluginInvocationKeys(normalizedCommand);
  const key = `/${normalizedName}`;

  for (const invocationKey of invocationKeys) {
    const existing = registry.commands.find((entry) =>
      listPluginInvocationKeys(entry.command).includes(invocationKey),
    );
    if (existing) {
      return {
        ok: false,
        error: `Command "${invocationKey.slice(1)}" already registered by plugin "${existing.pluginId}"`,
      };
    }
  }

  registry.commands.push({
    pluginId,
    pluginName: opts?.pluginName,
    rootDir: opts?.pluginRoot,
    source: opts?.pluginRoot ?? "runtime",
    command: normalizedCommand,
    ...(opts?.allowOwnerStatusExposure === true && normalizedCommand.exposeSenderIsOwner === true
      ? { trustedOwnerStatusExposure: true as const }
      : {}),
  });
  logVerbose(`Registered plugin command: ${key} (plugin: ${pluginId})`);
  return { ok: true };
}

export { clearPluginCommands };
