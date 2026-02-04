/**
 * memory_index_status — MCP tool for progressive memory health and stats.
 *
 * Part of the Progressive Memory System. Provides statistics for both the
 * legacy memory system and the new progressive store.
 *
 * This is ADDITIVE — it never touches memory_search or memory_get.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import {
  getProgressiveStore,
  isProgressiveMemoryEnabled,
} from "../../memory/progressive-manager.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult } from "./common.js";

const MemoryIndexStatusSchema = Type.Object({});

export function createMemoryIndexStatusTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  if (!isProgressiveMemoryEnabled(cfg)) return null;

  return {
    label: "Memory Index Status",
    name: "memory_index_status",
    description:
      "Health and statistics for both legacy and progressive memory systems. " +
      "Shows entry counts by category/priority, token estimates, and system health.",
    parameters: MemoryIndexStatusSchema,
    execute: async (_toolCallId, _params) => {
      try {
        const result: Record<string, unknown> = {};

        // Legacy system status
        try {
          const agentId = resolveSessionAgentId({
            sessionKey: options.agentSessionKey,
            config: cfg,
          });
          const { manager } = await getMemorySearchManager({ cfg, agentId });
          if (manager) {
            const legacyStatus = manager.status();
            result.legacy = {
              backend: legacyStatus.backend,
              provider: legacyStatus.provider,
              model: legacyStatus.model,
              files: legacyStatus.files,
              chunks: legacyStatus.chunks,
              vector: legacyStatus.vector?.enabled
                ? { enabled: true, dims: legacyStatus.vector.dims }
                : { enabled: false },
              fts: legacyStatus.fts,
              sources: legacyStatus.sourceCounts,
            };
          }
        } catch {
          result.legacy = { error: "Could not retrieve legacy status" };
        }

        // Progressive system status
        try {
          const { store } = await getProgressiveStore({ cfg });
          result.progressive = store.status();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.progressive = { error: message };
        }

        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message });
      }
    },
  };
}
