import { formatByteSize } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { AgentConfig } from "../../../../src/config/types.agents.js";
import type { GitHubToolIdentityConfig, ToolsConfig } from "../../../../src/config/types.tools.js";
import { formatAgentRuntimeLabel } from "../../../../src/shared/agent-runtime-display.js";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentAvatarUrl, resolveAssistantTextAvatar } from "../avatar.ts";
import { resolveAgentConfigEntryTarget } from "../config/config-state-model.ts";
import { normalizeAgentId } from "../sessions/session-key.ts";

type AgentRosterEntry = {
  id: string;
  kind?: "agent" | "system";
  name?: string;
  identity?: { name?: string };
};

/** Ordinary agent targets; system rows remain available to diagnostic surfaces. */
export function listSelectableAgents<T extends AgentRosterEntry>(agents: readonly T[]): T[] {
  return agents.filter((agent) => agent.kind !== "system");
}

export function findSelectableAgent<T extends AgentRosterEntry>(agents: readonly T[], id: string) {
  const selectedId = normalizeAgentId(id);
  return agents.find(
    (agent) => agent.kind !== "system" && normalizeAgentId(agent.id) === selectedId,
  );
}

export function selectableAgentsList(agentsList: AgentsListResult): AgentsListResult {
  return { ...agentsList, agents: listSelectableAgents(agentsList.agents) };
}

type AgentDisplayTools = Pick<ToolsConfig, "allow" | "alsoAllow" | "deny"> & {
  profile?: string;
  github?: Partial<Pick<GitHubToolIdentityConfig, "profileId" | "gitAuthor">>;
};

type AgentConfigEntry = Pick<
  AgentConfig,
  | "name"
  | "workspace"
  | "agentDir"
  | "decisionModel"
  | "utilityModel"
  | "skills"
  | "thinkingDefault"
> & {
  model?: unknown;
  models?: Record<string, { alias?: unknown }>;
  tools?: AgentDisplayTools;
};

type ConfigSnapshot = {
  agents?: {
    defaults?: Pick<
      AgentConfigEntry,
      "workspace" | "model" | "decisionModel" | "utilityModel" | "models" | "skills"
    >;
    entries?: Record<string, AgentConfigEntry>;
  };
  tools?: AgentDisplayTools;
};

export function normalizeAgentLabel(
  agent: AgentRosterEntry,
  hydratedIdentity?: { name?: string } | null,
) {
  // Roster labels own operator target identity; workspace identity only fills gaps.
  return (
    normalizeOptionalString(agent.name) ??
    normalizeOptionalString(agent.identity?.name) ??
    normalizeOptionalString(hydratedIdentity?.name) ??
    agent.id
  );
}

export function normalizeAgentTargetLabel(
  agent: AgentRosterEntry,
  hydratedIdentity?: Pick<AgentIdentityResult, "name" | "nameSource"> | null,
) {
  const resolvedName =
    hydratedIdentity?.nameSource && hydratedIdentity.nameSource !== "default"
      ? normalizeOptionalString(hydratedIdentity.name)
      : undefined;
  return resolvedName ?? normalizeAgentLabel(agent);
}

export function resolveAgentTextAvatar(
  agent: { identity?: { emoji?: string; avatar?: string } },
  agentIdentity?: AgentIdentityResult | null,
): string | null {
  const candidates = [
    normalizeOptionalString(agent.identity?.emoji),
    normalizeOptionalString(agent.identity?.avatar),
    normalizeOptionalString(agentIdentity?.emoji),
    normalizeOptionalString(agentIdentity?.avatar),
  ];
  return candidates.map(resolveAssistantTextAvatar).find(Boolean) ?? null;
}

export function formatBytes(bytes?: number) {
  if (bytes == null || !Number.isFinite(bytes)) {
    return "-";
  }
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (value, unit) => (unit === "byte" ? null : value < 10 ? 1 : 0),
  });
}

export function resolveAgentConfig(config: Record<string, unknown> | null, agentId: string) {
  const cfg = config as ConfigSnapshot | null;
  const entry = resolveAgentConfigEntryTarget(config, agentId)?.entry as
    | AgentConfigEntry
    | undefined;
  return {
    entry,
    defaults: cfg?.agents?.defaults,
    globalTools: cfg?.tools,
  };
}

/** Resolves the effective skill allowlist, including inherited agent defaults. */
export function resolveAgentSkillsFilter(config: Record<string, unknown> | null, agentId: string) {
  const resolved = resolveAgentConfig(config, agentId);
  const skills = Array.isArray(resolved.entry?.skills)
    ? resolved.entry.skills
    : resolved.defaults?.skills;
  return Array.isArray(skills) ? normalizeStringEntries(skills) : undefined;
}

export type AgentContext = ReturnType<typeof buildAgentContext>;

export function buildAgentContext(
  agent: AgentsListResult["agents"][number],
  configForm: Record<string, unknown> | null,
  agentFilesList: AgentsFilesListResult | null,
  defaultId: string | null,
  agentIdentity?: AgentIdentityResult | null,
) {
  const config = resolveAgentConfig(configForm, agent.id);
  const workspaceFromFiles =
    agentFilesList && agentFilesList.agentId === agent.id ? agentFilesList.workspace : null;
  const workspace =
    workspaceFromFiles ||
    config.entry?.workspace ||
    agent.workspace ||
    config.defaults?.workspace ||
    "default";
  const primary =
    resolveModelPrimary(config.entry?.model) ??
    resolveModelPrimary(config.defaults?.model) ??
    resolveModelPrimary(agent.model);
  const fallbacks =
    resolveEffectiveModelFallbacks(config.entry?.model, config.defaults?.model) ??
    (configForm ? null : resolveModelFallbacks(agent.model));
  const modelLabel =
    primary && fallbacks?.length ? `${primary} (+${fallbacks.length} fallback)` : (primary ?? "-");
  const runtime = formatAgentRuntimeLabel(agent.agentRuntime);
  const identityName =
    normalizeOptionalString(agent.identity?.name) ||
    normalizeOptionalString(agent.name) ||
    normalizeOptionalString(agentIdentity?.name) ||
    config.entry?.name ||
    agent.id;
  const identityAvatar = resolveAgentAvatarUrl(agent, agentIdentity)
    ? "custom"
    : (resolveAgentTextAvatar(agent, agentIdentity) ?? "—");
  const skillFilter = resolveAgentSkillsFilter(configForm, agent.id);
  return {
    workspace,
    model: modelLabel,
    runtime,
    identityName,
    identityAvatar,
    skillsLabel: skillFilter
      ? t("agents.overview.selectedSkills", { count: String(skillFilter.length) })
      : t("agents.overview.allSkills"),
    isDefault: Boolean(defaultId && agent.id === defaultId),
  };
}

export function resolveModelPrimary(model?: unknown): string | null {
  if (typeof model === "string") {
    return normalizeOptionalString(model) ?? null;
  }
  if (!model || typeof model !== "object") {
    return null;
  }
  const record = model as Record<string, unknown>;
  const candidate = [record.primary, record.model, record.id, record.value].find(
    (value) => typeof value === "string",
  );
  return normalizeOptionalString(candidate) ?? null;
}

export function resolveModelFallbacks(model?: unknown): string[] | null {
  if (!model || typeof model !== "object") {
    return null;
  }
  const record = model as Record<string, unknown>;
  const fallbacks = Array.isArray(record.fallbacks)
    ? record.fallbacks
    : Array.isArray(record.fallback)
      ? record.fallback
      : null;
  return fallbacks ? fallbacks.filter((entry): entry is string => typeof entry === "string") : null;
}

export function resolveEffectiveModelFallbacks(
  entryModel?: unknown,
  defaultModel?: unknown,
): string[] | null {
  // An agent-owned primary is strict; only an inherited primary can use
  // the global fallback chain, matching the Gateway's model routing.
  return (
    resolveModelFallbacks(entryModel) ??
    (resolveModelPrimary(entryModel) ? [] : resolveModelFallbacks(defaultModel))
  );
}
