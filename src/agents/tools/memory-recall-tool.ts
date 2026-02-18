import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { getBioMemManager } from "../../memory/bio-mem/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import type { AnyAgentTool } from "./common.js";

const MemoryRecallSchema = Type.Object({
  query: Type.String(),
  maxEpisodes: Type.Optional(Type.Number()),
  maxNodes: Type.Optional(Type.Number()),
});

export function createMemoryRecallTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const bioMemCfg = cfg.memory?.bioMem;
  if (bioMemCfg?.enabled === false) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Memory Recall",
    name: "memory_recall",
    description:
      "Retrieve relevant episodic memories and semantic knowledge from past sessions. Returns top matching episodes (what happened, what was done, what the outcome was) and semantic nodes (user preferences, skills, rules). Use before memory_search for cross-session recall.",
    parameters: MemoryRecallSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxEpisodes = readNumberParam(params, "maxEpisodes", { integer: true });
      const maxNodes = readNumberParam(params, "maxNodes", { integer: true });
      try {
        const manager = await getBioMemManager(cfg, agentId);
        if (!manager) {
          return jsonResult({ episodes: [], semanticNodes: [], disabled: true });
        }
        const [episodes, semanticNodes] = await Promise.all([
          manager.searchEpisodes(query, maxEpisodes ?? 3),
          Promise.resolve(manager.getSemanticNodes(query, maxNodes ?? 5)),
        ]);
        const episodeSummaries = episodes.map((ep) => ({
          week: formatWeek(ep.timestamp),
          user_intent: ep.user_intent,
          action_taken: ep.action_taken,
          outcome: ep.outcome,
        }));
        const nodeSummaries = semanticNodes.map((n) => ({
          type: n.type,
          label: n.label,
          value: n.value,
          evidence_count: n.evidence_count,
        }));
        return jsonResult({ episodes: episodeSummaries, semanticNodes: nodeSummaries });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ episodes: [], semanticNodes: [], error: message });
      }
    },
  };
}

function formatWeek(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(
    ((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getUTCDay() + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, "0")}`;
}
