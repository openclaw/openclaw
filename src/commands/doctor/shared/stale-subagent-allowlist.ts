import { resolveConfiguredAcpSubagentTargetIds } from "../../../agents/agent-roster.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { groupPluginRecords as groupRecords } from "../../../plugins/record-groups.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";

type StaleSubagentAllowlistHit = {
  pathLabel: string;
  /** Original configured agent id. */
  agentId: string;
  /** Normalized agent id used for matching configured targets. */
  normalizedAgentId: string;
};

function listSubagentAllowlists(cfg: OpenClawConfig) {
  return [
    { agent: cfg.agents?.defaults, path: "agents.defaults" },
    ...listMutableCodexRouteAgentEntries(cfg),
  ].flatMap(({ agent, path }) => {
    const subagents = agent?.subagents;
    return subagents && typeof subagents === "object" && "allowAgents" in subagents
      ? [{ subagents, pathLabel: `${path}.subagents.allowAgents` }]
      : [];
  });
}

export function scanStaleSubagentAllowlistReferences(
  cfg: OpenClawConfig,
): StaleSubagentAllowlistHit[] {
  const configuredTargetIds = resolveConfiguredAcpSubagentTargetIds(cfg);
  return listSubagentAllowlists(cfg).flatMap(({ subagents, pathLabel }) => {
    const allowAgents = subagents.allowAgents;
    if (!Array.isArray(allowAgents)) {
      return [];
    }
    const hits: StaleSubagentAllowlistHit[] = [];
    const seen = new Set<string>();
    for (const entry of allowAgents) {
      if (typeof entry !== "string") {
        continue;
      }
      const trimmed = entry.trim();
      if (!trimmed || trimmed === "*") {
        continue;
      }
      const normalizedAgentId = normalizeAgentId(trimmed);
      if (configuredTargetIds.has(normalizedAgentId) || seen.has(normalizedAgentId)) {
        continue;
      }
      seen.add(normalizedAgentId);
      hits.push({
        pathLabel,
        agentId: trimmed,
        normalizedAgentId,
      });
    }
    return hits;
  });
}

export function collectStaleSubagentAllowlistWarnings(params: {
  hits: readonly StaleSubagentAllowlistHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  return [
    ...params.hits.map(
      (hit) =>
        `- ${hit.pathLabel}: stale subagent target "${hit.agentId}" is not in the configured agent registry.`,
    ),
    `- Run "${params.doctorFixCommand}" to remove stale subagent target ids, or add a configured agent or ACP target for each intended target.`,
  ];
}

/** Remove stale subagent allowlist entries while preserving valid targets and wildcards. */
export function maybeRepairStaleSubagentAllowlists(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const hits = scanStaleSubagentAllowlistReferences(cfg);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const hitsByPath = groupRecords(hits, (hit) => hit.pathLabel);

  for (const { subagents, pathLabel } of listSubagentAllowlists(next)) {
    const pathHits = hitsByPath.get(pathLabel);
    if (!pathHits || !Array.isArray(subagents.allowAgents)) {
      continue;
    }
    const staleTargetIds = new Set(pathHits.map((hit) => hit.normalizedAgentId));
    subagents.allowAgents = subagents.allowAgents.filter((entry: unknown) => {
      if (typeof entry !== "string") {
        return true;
      }
      const trimmed = entry.trim();
      return !trimmed || trimmed === "*" || !staleTargetIds.has(normalizeAgentId(trimmed));
    });
  }

  const changes = [...hitsByPath.entries()].map(([pathLabel, pathHits]) => {
    const ids = pathHits.map((hit) => hit.agentId).join(", ");
    return `- ${pathLabel}: removed ${pathHits.length} stale subagent target id${pathHits.length === 1 ? "" : "s"} (${ids})`;
  });

  return { config: next, changes };
}
