import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { listVisibleSpecialistTeams } from "../../operator-control/specialist-resolver.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveSubagentTargetReadiness } from "../subagent-target-readiness.js";
import { resolveRequesterSubagentAllowlist } from "../universal-targets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const AgentsListToolSchema = Type.Object({});

type AgentListEntry = {
  id: string;
  name?: string;
  configured: boolean;
};

export function createAgentsListTool(opts?: {
  agentSessionKey?: string;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Agents",
    name: "agents_list",
    description:
      'List OpenClaw agent ids you can target with `sessions_spawn` when `runtime="subagent"` (based on subagent allowlists plus universal targets).',
    parameters: AgentsListToolSchema,
    execute: async () => {
      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : alias;
      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ??
          parseAgentSessionKey(requesterInternalKey)?.agentId ??
          DEFAULT_AGENT_ID,
      );

      const { allowAny, allowSet, explicitAllowSet } = resolveRequesterSubagentAllowlist({
        cfg,
        requesterAgentId,
      });

      const configuredAgents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
      const configuredIds = configuredAgents.map((entry) => normalizeAgentId(entry.id));
      const configuredNameMap = new Map<string, string>();
      for (const entry of configuredAgents) {
        const name = entry?.name?.trim() ?? "";
        if (!name) {
          continue;
        }
        configuredNameMap.set(normalizeAgentId(entry.id), name);
      }

      const allowed = new Set<string>([requesterAgentId]);
      if (allowAny) {
        for (const id of configuredIds) {
          const readiness = resolveSubagentTargetReadiness({
            cfg,
            requesterAgentId,
            targetAgentId: id,
          });
          if (readiness.status === "ready") {
            allowed.add(id);
          }
        }
      }
      for (const id of allowSet) {
        const readiness = resolveSubagentTargetReadiness({
          cfg,
          requesterAgentId,
          targetAgentId: id,
          classifyStaleAllowlist: explicitAllowSet.has(id),
        });
        if (readiness.status === "ready") {
          allowed.add(id);
        }
      }

      const all = Array.from(allowed);
      const rest = all
        .filter((id) => id !== requesterAgentId)
        .toSorted((a, b) => a.localeCompare(b));
      const ordered = [requesterAgentId, ...rest];
      const agents: AgentListEntry[] = ordered.map((id) => ({
        id,
        name: configuredNameMap.get(id),
        configured: configuredIds.includes(id),
      }));
      const teams = listVisibleSpecialistTeams({
        requesterId: requesterAgentId,
        configuredAgentIds: configuredIds,
      });

      return jsonResult({
        requester: requesterAgentId,
        allowAny,
        agents,
        teams,
      });
    },
  };
}
