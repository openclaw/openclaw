import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import {
  DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
} from "../config/agent-limits.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAvatarDataUrl } from "../shared/avatar-policy.js";
import { ClawMigrationError } from "./migrate-errors.js";
import { isPortableClawAvatar } from "./schema-portability.js";

export function containsPotentialSecret(value: string): boolean {
  return (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value) ||
    /\b(?:sk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/u.test(
      value,
    ) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,}/iu.test(value) ||
    /\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?Basic\s+[A-Za-z0-9+/]{4,}={0,2}/iu.test(value) ||
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u.test(value) ||
    /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret|token)(?:[_-][A-Za-z0-9]+)*\s*[:=]\s*["']?(?!\$\{|\{\{|<|YOUR_|REPLACE_|EXAMPLE)([A-Za-z0-9/+_=-]{16,})/iu.test(
      value,
    )
  );
}

export function inspectValueForSecret(value: unknown): boolean {
  if (typeof value === "string") {
    return containsPotentialSecret(value);
  }
  if (Array.isArray(value)) {
    return value.some(inspectValueForSecret);
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(inspectValueForSecret);
  }
  return false;
}

export function normalizeWorkspaceConfig(
  agent: AgentConfig,
  workspace: string,
): AgentConfig & { workspace: string } {
  return {
    ...agent,
    ...(typeof agent.model === "string" ? { model: { primary: agent.model } } : {}),
    id: agent.id,
    workspace,
  };
}

/** Keeps source roster ownership when runtime migration materializes an implicit main agent. */
export function withAuthoredAgentRoster(
  config: OpenClawConfig,
  source: OpenClawConfig | undefined,
): OpenClawConfig {
  const sourceAgents = source?.agents;
  if (!sourceAgents) {
    return config;
  }
  const agents = { ...config.agents };
  if (Object.hasOwn(sourceAgents, "entries") && sourceAgents.entries !== undefined) {
    agents.entries = structuredClone(sourceAgents.entries);
    delete agents.list;
  } else if (Object.hasOwn(sourceAgents, "list") && sourceAgents.list !== undefined) {
    agents.list = structuredClone(sourceAgents.list);
    delete agents.entries;
  } else {
    return config;
  }
  if (sourceAgents.ownership !== undefined) {
    agents.ownership = sourceAgents.ownership;
  }
  return { ...config, agents };
}

export function validateAgentConfigKeys(agent: AgentConfig): void {
  const representable = new Set([
    "id",
    "name",
    "description",
    "identity",
    "model",
    "subagents",
    "groupChat",
    "sandbox",
    "tools",
    "memory",
    "heartbeat",
    "humanDelay",
    "workspace",
  ]);
  const unsupported = Object.keys(agent).filter((key) => !representable.has(key));
  if (unsupported.length > 0) {
    throw new ClawMigrationError(
      "agent_setting_unsupported",
      `Agent settings cannot be represented by Claw v1: ${unsupported.toSorted().join(", ")}. Remove or move those settings before migrating.`,
      "$.agent",
    );
  }
  const avatar = agent.identity?.avatar?.trim();
  if (avatar && (!isAvatarDataUrl(avatar) || !isPortableClawAvatar(avatar))) {
    throw new ClawMigrationError(
      "agent_avatar_unsupported",
      "This migration can represent an embedded portable image avatar, but not a URL or local avatar path. Keep the avatar unmanaged or convert it to a supported image data URL before migrating.",
      "$.agent.identity.avatar",
    );
  }
}

type ModelConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["model"];

function modelPrimary(model: ModelConfig): string | undefined {
  if (typeof model === "string") {
    return model;
  }
  return model?.primary;
}

function unsupportedFields(value: unknown, fields: readonly string[], prefix: string): string[] {
  const source = record(value);
  if (!source) {
    return [];
  }
  return Object.keys(source)
    .filter((field) => !fields.includes(field))
    .map((field) => `${prefix}.${field}`);
}

function unsupportedSubagentDefaultFields(value: unknown): string[] {
  const source = record(value);
  if (!source) {
    return [];
  }
  return Object.keys(source)
    .filter((field) => {
      if (field === "allowAgents" || field === "delegationMode") {
        return false;
      }
      if (field === "maxConcurrent" && source.maxConcurrent === DEFAULT_SUBAGENT_MAX_CONCURRENT) {
        return false;
      }
      if (
        field === "archiveAfterMinutes" &&
        source.archiveAfterMinutes === DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES
      ) {
        return false;
      }
      return true;
    })
    .map((field) => `agents.defaults.subagents.${field}`);
}

function inheritPortableSettings<T extends object>(
  settings: T | undefined,
  defaults: Partial<T> | undefined,
  keys: readonly (keyof T)[],
): Partial<T> {
  const inherited: Partial<T> = { ...settings };
  for (const key of keys) {
    if (inherited[key] === undefined && defaults?.[key] !== undefined) {
      inherited[key] = defaults[key];
    }
  }
  return inherited;
}

export function resolveMigrationAgentSettings(
  config: OpenClawConfig,
  agent: AgentConfig,
): AgentConfig {
  const defaults = config.agents?.defaults;
  if (!defaults) {
    return agent;
  }
  const hostDefaults = new Set([
    "workspace",
    "modelSelectionScope",
    "systemAgent",
    "authInheritance",
    "sessionStore",
    "maxConcurrent",
  ]);
  const portableDefaults = new Set(["model", "subagents", "heartbeat", "sandbox", "humanDelay"]);
  const unsupportedDefaults = Object.keys(defaults).flatMap((key) => {
    const compaction = record(defaults.compaction);
    // Config materialization injects this effective default even when the user
    // has no compaction settings. It has the same behavior as an unset value.
    if (
      key === "compaction" &&
      (Object.keys(compaction ?? {}).length === 0 ||
        (Object.keys(compaction ?? {}).length === 1 && compaction?.mode === "safeguard"))
    ) {
      return [];
    }
    if (hostDefaults.has(key) || portableDefaults.has(key)) {
      return [];
    }
    return [`agents.defaults.${key}`];
  });
  unsupportedDefaults.push(
    ...unsupportedSubagentDefaultFields(defaults.subagents),
    ...unsupportedFields(
      defaults.heartbeat,
      ["agentId", "every", "activeHours", "lightContext", "isolatedSession", "timeoutSeconds"],
      "agents.defaults.heartbeat",
    ),
    ...unsupportedFields(
      record(defaults.heartbeat)?.activeHours,
      ["start", "end", "timezone"],
      "agents.defaults.heartbeat.activeHours",
    ),
    ...unsupportedFields(
      defaults.sandbox,
      ["mode", "scope", "workspaceAccess"],
      "agents.defaults.sandbox",
    ),
    ...unsupportedFields(
      defaults.humanDelay,
      ["mode", "minMs", "maxMs"],
      "agents.defaults.humanDelay",
    ),
  );
  if (unsupportedDefaults.length > 0) {
    throw new ClawMigrationError(
      "agent_default_setting_unsupported",
      `Inherited agent settings cannot be represented by Claw v1: ${unsupportedDefaults.toSorted().join(", ")}. Keep this agent unmanaged or remove those defaults before migrating.`,
      "$.agents.defaults",
    );
  }

  const inheritedSubagents = inheritPortableSettings(agent.subagents, defaults.subagents, [
    "allowAgents",
    "delegationMode",
  ]);
  const inheritedHeartbeat = inheritPortableSettings(agent.heartbeat, defaults.heartbeat, [
    "every",
    "activeHours",
    "lightContext",
    "isolatedSession",
    "timeoutSeconds",
  ]);
  const inheritedSandbox = inheritPortableSettings(agent.sandbox, defaults.sandbox, [
    "mode",
    "scope",
    "workspaceAccess",
  ]);
  const inheritedHumanDelay = inheritPortableSettings(agent.humanDelay, defaults.humanDelay, [
    "mode",
    "minMs",
    "maxMs",
  ]);
  const inheritedAgent = {
    ...agent,
    ...(Object.keys(inheritedSubagents).length > 0 ? { subagents: inheritedSubagents } : {}),
    ...(Object.keys(inheritedHeartbeat).length > 0 ? { heartbeat: inheritedHeartbeat } : {}),
    ...(Object.keys(inheritedSandbox).length > 0 ? { sandbox: inheritedSandbox } : {}),
    ...(Object.keys(inheritedHumanDelay).length > 0 ? { humanDelay: inheritedHumanDelay } : {}),
  };

  const defaultModel = defaults.model;
  if (defaultModel === undefined) {
    return inheritedAgent;
  }
  const primary = modelPrimary(agent.model) ?? modelPrimary(defaultModel);
  const hasAgentFallbacks = typeof agent.model === "object" && Array.isArray(agent.model.fallbacks);
  const hasDefaultFallbacks =
    typeof defaultModel === "object" && Array.isArray(defaultModel.fallbacks);
  const fallbacks = hasAgentFallbacks
    ? resolveAgentModelFallbackValues(agent.model)
    : resolveAgentModelFallbackValues(defaultModel);
  const effectiveModel =
    typeof agent.model === "string" && !hasDefaultFallbacks
      ? agent.model
      : {
          ...(typeof agent.model === "object" ? agent.model : {}),
          ...(primary ? { primary } : {}),
          ...(hasAgentFallbacks || hasDefaultFallbacks ? { fallbacks } : {}),
        };
  return { ...inheritedAgent, model: effectiveModel };
}
