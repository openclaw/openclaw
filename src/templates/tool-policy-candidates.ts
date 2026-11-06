import { realpathSync } from "node:fs";
import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import { listAgentEntries, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { digestTemplateOwnedAgentConfig } from "./agent-config-ownership.js";
import { digestTemplateValue } from "./digest.js";

class TemplateMigrationError extends Error {
  readonly path = "$.agents.defaults";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TemplateMigrationError";
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
function resolveMigrationAgentSettings(config: OpenClawConfig, agent: AgentConfig): AgentConfig {
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
    throw new TemplateMigrationError(
      "agent_default_setting_unsupported",
      `Inherited agent settings cannot be represented by Template v1: ${unsupportedDefaults.toSorted().join(", ")}. Keep this agent unmanaged or remove those defaults before migrating.`,
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

export type TemplateToolPolicyCandidate = {
  agentId: string;
  agentConfigDigest: string;
  adoptedAgentConfigDigests: (env?: NodeJS.ProcessEnv) => { owned: string; legacy: string };
  legacyAgentConfigDigest: string;
  tools: object;
};

export function collectTemplateToolPolicyCandidates(
  config: OpenClawConfig,
): TemplateToolPolicyCandidate[] {
  return listAgentEntries(config).flatMap((agent) => {
    const tools = agent.tools;
    if (!tools || (!tools.profile && !tools.allow?.length)) {
      return [];
    }
    let adoptedDigests: { owned: string; legacy: string } | undefined;
    return [
      {
        agentId: agent.id,
        agentConfigDigest: digestTemplateOwnedAgentConfig(agent),
        legacyAgentConfigDigest: digestTemplateValue(agent),
        // Adoption resolves effective settings and the canonical workspace
        // without rewriting authored config. Keep the older full digest readable.
        adoptedAgentConfigDigests: (env) => {
          if (adoptedDigests) {
            return adoptedDigests;
          }
          const settings = resolveMigrationAgentSettings(config, agent);
          const workspace = realpathSync(resolveAgentWorkspaceDir(config, agent.id, env));
          const effective = {
            ...settings,
            ...(typeof settings.model === "string" ? { model: { primary: settings.model } } : {}),
            id: settings.id,
            workspace,
          };
          adoptedDigests = {
            owned: digestTemplateOwnedAgentConfig(effective),
            legacy: digestTemplateValue(effective),
          };
          return adoptedDigests;
        },
        tools,
      },
    ];
  });
}
