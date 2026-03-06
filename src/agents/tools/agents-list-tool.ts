import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveAgentConfig } from "../agent-scope.js";
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
      'List OpenClaw agent ids you can target with `sessions_spawn` when `runtime="subagent"` (based on subagent allowlists).',
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

      // Distinguish between "not configured" (undefined) and "explicitly empty" ([]).
      // When allowAgents is not configured, fall back to all configured agents so
      // that the tool matches the behavior of `openclaw agents list` in the CLI.
      const rawAllowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents;
      const allowAgentsConfigured = Array.isArray(rawAllowAgents);
      const allowAgents = rawAllowAgents ?? [];
      const allowAny = allowAgents.some((value) => value.trim() === "*");
      const allowSet = new Set(
        allowAgents
          .filter((value) => value.trim() && value.trim() !== "*")
          .map((value) => normalizeAgentId(value)),
      );

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

      const allowed = new Set<string>();
      allowed.add(requesterAgentId);
      if (allowAny || !allowAgentsConfigured) {
        // allowAny: explicit "*" wildcard; !allowAgentsConfigured: no allowlist set,
        // so show all configured agents (matches `openclaw agents list` CLI behavior).
        for (const id of configuredIds) {
          allowed.add(id);
        }
      } else {
        for (const id of allowSet) {
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

      return jsonResult({
        requester: requesterAgentId,
        allowAny,
        agents,
      });
    },
  };
}
