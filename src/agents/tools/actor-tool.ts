import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const ActorLookupSchema = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Number()),
});

export function createActorLookupTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return {
    label: "Actor Lookup",
    name: "actor_lookup",
    description:
      "Lookup actors by name/alias across channels to resolve a canonical actor id.",
    parameters: ActorLookupSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit");
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ actors: [], disabled: true, error });
      }
      const lookup = (manager as {
        lookupActors?: (input: { query: string; limit?: number }) => Promise<unknown>;
      }).lookupActors;
      if (!lookup) {
        return jsonResult({
          actors: [],
          disabled: true,
          error: "actor directory unavailable",
        });
      }
      try {
        const actors = await lookup({ query, limit: limit ?? undefined });
        return jsonResult({ actors });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ actors: [], disabled: true, error: message });
      }
    },
  };
}
