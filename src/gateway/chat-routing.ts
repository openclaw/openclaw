import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type ResolvedOrchestrationPolicy = {
  defaultBehavior: "orchestrate";
  fallbackBehavior: "self-answer";
  directRoutingMode: "hint" | "force";
  allowMultiAgentDelegation: boolean;
  preserveUserVisibleSingleChat: boolean;
};

export type DirectedAgentRequest = {
  targetAgentId: string;
  strippedMessage: string;
  alias: string;
  mode: "hint" | "force";
  description?: string;
  routingHints: string[];
};

type RoutingAliasEntry = {
  agentId: string;
  aliases: string[];
  description?: string;
  routingHints: string[];
};

const DEFAULT_ORCHESTRATION_POLICY: ResolvedOrchestrationPolicy = {
  defaultBehavior: "orchestrate",
  fallbackBehavior: "self-answer",
  directRoutingMode: "hint",
  allowMultiAgentDelegation: true,
  preserveUserVisibleSingleChat: true,
};

const LEGACY_AGENT_ALIAS_PRESETS: Record<string, string[]> = {
  main: ["main"],
  ceo: ["ceo", "strategy"],
  legal: ["legal", "law"],
  design: ["design", "brand", "branding"],
  house: ["house", "engineer", "build"],
  tea: ["tea"],
  trk: ["rail", "wagon", "wagons"],
  auto: ["automation", "ops", "workflow"],
};

function slugifyWords(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function listConfiguredAgentIds(cfg: OpenClawConfig): Set<string> {
  return new Set(
    (cfg.agents?.list ?? []).map((entry) => normalizeAgentId(entry?.id)).filter(Boolean),
  );
}

export function resolveAgentOrchestrationPolicy(cfg: OpenClawConfig): ResolvedOrchestrationPolicy {
  const raw = cfg.agents?.orchestration?.policy;
  return {
    defaultBehavior: raw?.defaultBehavior ?? DEFAULT_ORCHESTRATION_POLICY.defaultBehavior,
    fallbackBehavior: raw?.fallbackBehavior ?? DEFAULT_ORCHESTRATION_POLICY.fallbackBehavior,
    directRoutingMode: raw?.directRoutingMode ?? DEFAULT_ORCHESTRATION_POLICY.directRoutingMode,
    allowMultiAgentDelegation:
      raw?.allowMultiAgentDelegation ?? DEFAULT_ORCHESTRATION_POLICY.allowMultiAgentDelegation,
    preserveUserVisibleSingleChat:
      raw?.preserveUserVisibleSingleChat ??
      DEFAULT_ORCHESTRATION_POLICY.preserveUserVisibleSingleChat,
  };
}

export function resolveConfiguredRoutingAliases(cfg: OpenClawConfig): RoutingAliasEntry[] {
  const configuredIds = listConfiguredAgentIds(cfg);
  const configured = cfg.agents?.orchestration?.routingAliases ?? [];
  if (configured.length > 0) {
    return configured
      .map((entry) => {
        const agentId = normalizeAgentId(entry.agentId);
        if (!agentId || !configuredIds.has(agentId)) {
          return null;
        }
        const aliases = Array.from(
          new Set(
            [agentId, ...(entry.aliases ?? [])]
              .flatMap((value) => slugifyWords(value))
              .filter(Boolean),
          ),
        );
        return {
          agentId,
          aliases,
          description: entry.description?.trim() || undefined,
          routingHints: (entry.routingHints ?? []).flatMap((value) => slugifyWords(value)),
        };
      })
      .filter((entry): entry is RoutingAliasEntry => Boolean(entry));
  }

  return (cfg.agents?.list ?? [])
    .map((entry) => {
      const agentId = normalizeAgentId(entry?.id);
      if (!agentId) {
        return null;
      }
      const aliases = Array.from(
        new Set([
          agentId,
          ...slugifyWords(entry?.name ?? ""),
          ...(LEGACY_AGENT_ALIAS_PRESETS[agentId] ?? []),
        ]),
      );
      return {
        agentId,
        aliases,
        description: typeof entry?.name === "string" ? entry.name.trim() || undefined : undefined,
        routingHints: [],
      };
    })
    .filter((entry): entry is RoutingAliasEntry => Boolean(entry));
}

export function resolveAgentAlias(cfg: OpenClawConfig, alias: string): RoutingAliasEntry | null {
  const normalizedAlias = alias.trim().toLowerCase();
  if (!normalizedAlias) {
    return null;
  }
  return (
    resolveConfiguredRoutingAliases(cfg).find((entry) => entry.aliases.includes(normalizedAlias)) ??
    null
  );
}

export function resolveDirectedAgentRequest(params: {
  cfg: OpenClawConfig;
  message: string;
  currentAgentId: string;
  defaultAgentId: string;
}): DirectedAgentRequest | null {
  if (params.currentAgentId !== params.defaultAgentId) {
    return null;
  }
  const match = params.message.match(/^\s*@([a-z][a-z0-9_-]*)\b\s*(.*)$/is);
  if (!match) {
    return null;
  }
  const alias = match[1].toLowerCase();
  const strippedMessage = match[2]?.trim() ?? "";
  if (!strippedMessage) {
    return null;
  }
  const resolved = resolveAgentAlias(params.cfg, alias);
  if (!resolved) {
    return null;
  }
  const policy = resolveAgentOrchestrationPolicy(params.cfg);
  return {
    targetAgentId: resolved.agentId,
    strippedMessage,
    alias,
    mode: policy.directRoutingMode,
    description: resolved.description,
    routingHints: resolved.routingHints,
  };
}

export function buildDirectedAgentBodyForAgent(params: {
  targetAgentId: string;
  strippedMessage: string;
  originalMessage: string;
  alias: string;
  mode: "hint" | "force";
  description?: string;
  routingHints?: string[];
}): string {
  return [
    params.mode === "force" ? "[Direct routing directive]" : "[Direct routing request]",
    `Target specialist: ${params.targetAgentId}`,
    `Route alias: @${params.alias}`,
    params.description ? `Description: ${params.description}` : "",
    params.routingHints && params.routingHints.length > 0
      ? `Routing hints: ${params.routingHints.join(", ")}`
      : "",
    params.mode === "force"
      ? "Treat this as an explicit route unless it is impossible or unsafe."
      : "Use this as an explicit routing hint if a specialist handoff is appropriate.",
    "Pass only a short objective, constraints, and essential artifacts to the specialist.",
    "",
    "[User request after route prefix]",
    params.strippedMessage,
    "",
    "[Original user message]",
    params.originalMessage,
  ]
    .filter(Boolean)
    .join("\n");
}
