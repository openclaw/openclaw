import { Type, type Static } from "typebox";
import { GatewayAgentRuntimeSchema } from "../../../packages/gateway-protocol/src/schema/model-runtime-options.js";
import { getRuntimeConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveModelAgentRuntimeMetadata } from "../agent-runtime-metadata.js";
import { listAgentEntries, listAgentIds } from "../agent-scope-config.js";
import { resolveAgentConfig, resolveSessionAgentIds } from "../agent-scope.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { resolveSubagentAllowedTargetIds } from "../subagents/spawn/subagent-target-policy.js";
import { describeAgentsListTool } from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const AgentsListToolSchema = Type.Object({});
const AgentsListOutputSchema = Type.Object(
  {
    requester: Type.String(),
    allowAny: Type.Boolean(),
    agents: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          name: Type.Optional(Type.String()),
          configured: Type.Boolean(),
          model: Type.Optional(Type.String()),
          agentRuntime: Type.Optional(
            Type.Object(
              {
                id: Type.String(),
                source: GatewayAgentRuntimeSchema.properties.source,
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type AgentListEntry = Static<typeof AgentsListOutputSchema>["agents"][number];

export function createAgentsListTool(opts?: {
  agentSessionKey?: string;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Agents",
    name: "agents_list",
    description: describeAgentsListTool(false),
    parameters: AgentsListToolSchema,
    outputSchema: AgentsListOutputSchema,
    execute: async () => {
      const cfg = getRuntimeConfig();
      const { alias } = resolveMainSessionAlias(cfg);
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias })
          : alias;
      const requesterAgentId = resolveSessionAgentIds({
        config: cfg,
        sessionKey: requesterInternalKey,
        agentId: opts?.requesterAgentIdOverride,
      }).sessionAgentId;

      const allowAgents =
        resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
        cfg?.agents?.defaults?.subagents?.allowAgents;

      const configuredAgents = listAgentEntries(cfg);
      const configuredIds = listAgentIds(cfg);
      const configuredIdSet = new Set(configuredIds);
      const configuredNameMap = new Map<string, string>();
      for (const entry of configuredAgents) {
        const name = entry?.name?.trim() ?? "";
        if (!name) {
          continue;
        }
        configuredNameMap.set(normalizeAgentId(entry.id), name);
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
        const resolvedModel = resolveDefaultModelForAgent({ cfg, agentId: id });
        // Publish the resolved identity (aliases are routing-only) so the model
        // field matches the agentRuntime derived from the same resolvedModel.
        const model = `${resolvedModel.provider}/${resolvedModel.model}`;
        const agentRuntime = resolveModelAgentRuntimeMetadata({
          cfg,
          agentId: id,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
        });
        return {
          id,
          name: configuredNameMap.get(id),
          configured: configuredIdSet.has(id),
          model,
          agentRuntime,
        };
      });

      return jsonResult({
        requester: requesterAgentId,
        allowAny: allowed.allowAny,
        agents,
      });
    },
  };
}
