/**
 * agents_list built-in tool.
 *
 * Lists configured or allowed agent ids plus model/runtime metadata for subagent spawn decisions.
 */
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveModelAgentRuntimeMetadata } from "../agent-runtime-metadata.js";
import { listAgentIds } from "../agent-scope-config.js";
import { resolveAgentConfig, resolveAgentEffectiveModelPrimary } from "../agent-scope.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { resolveSubagentAllowedTargetIds } from "../subagent-target-policy.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const AgentsListToolSchema = Type.Object({});

type AgentListEntry = {
  id: string;
  name?: string;
  description?: string;
  configured: boolean;
  model?: string;
  agentRuntime?: {
    id: string;
    source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit" | "session-key";
  };
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
      'List agent ids allowed for `sessions_spawn runtime="subagent"`; includes configured names and descriptions when present.',
    parameters: AgentsListToolSchema,
    execute: async () => {
      const cfg = getRuntimeConfig();
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

      const allowAgents =
        resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
        cfg?.agents?.defaults?.subagents?.allowAgents;

      const configuredAgents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
      const configuredIds = listAgentIds(cfg);
      const configuredNameMap = new Map<string, string>();
      const configuredDescriptionMap = new Map<string, string>();
      for (const entry of configuredAgents) {
        const id = normalizeAgentId(entry.id);
        const name = entry?.name?.trim() ?? "";
        if (name) {
          configuredNameMap.set(id, name);
        }
        const description = entry?.description?.trim() ?? "";
        if (description) {
          configuredDescriptionMap.set(id, description);
        }
      }

      const allowed = resolveSubagentAllowedTargetIds({
        requesterAgentId,
        allowAgents,
        configuredAgentIds: configuredIds,
      });
      const all = allowed.allowedIds;
      const rest = all
        .filter((id) => id !== requesterAgentId)
        .toSorted((a, b) => a.localeCompare(b));
      const ordered = all.includes(requesterAgentId) ? [requesterAgentId, ...rest] : rest;
      const agents: AgentListEntry[] = ordered.map((id) => {
        const model = resolveAgentEffectiveModelPrimary(cfg, id);
        const resolvedModel = resolveDefaultModelForAgent({ cfg, agentId: id });
        const agentRuntime = resolveModelAgentRuntimeMetadata({
          cfg,
          agentId: id,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
        });
        const entry: AgentListEntry = {
          id,
          name: configuredNameMap.get(id),
          configured: configuredIds.includes(id),
          model,
          agentRuntime,
        };
        const description = configuredDescriptionMap.get(id);
        if (description) {
          entry.description = description;
        }
        return entry;
      });

      return jsonResult({
        requester: requesterAgentId,
        allowAny: allowed.allowAny,
        agents,
      });
    },
  };
}
