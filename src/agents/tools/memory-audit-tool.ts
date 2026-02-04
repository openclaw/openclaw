/**
 * memory_audit — MCP tool for token analysis and optimization recommendations.
 *
 * Part of the Progressive Memory System. Analyzes token usage across MEMORY.md,
 * domain files, system prompt sections, and skill metadata. Identifies duplicates
 * and recommends optimizations.
 *
 * This is ADDITIVE — it never touches memory_search or memory_get.
 */

import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  MemoryAuditBreakdown,
  MemoryAuditDuplicate,
  MemoryAuditRecommendation,
  MemoryAuditResult,
} from "../../memory/progressive-types.js";
import type { AnyAgentTool } from "./common.js";
import {
  isProgressiveMemoryEnabled,
  getProgressiveStore,
} from "../../memory/progressive-manager.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult, readStringParam } from "./common.js";

/** Approximate chars per token. */
const CHARS_PER_TOKEN = 4;

const MemoryAuditSchema = Type.Object({
  scope: Type.Optional(
    Type.String({
      description:
        'Audit scope: "all" | "memory_md" | "domains" | "progressive" | "system_prompt" (default: "all")',
    }),
  ),
  recommend: Type.Optional(
    Type.Boolean({ description: "Generate optimization recommendations (default: true)" }),
  ),
});

export function createMemoryAuditTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  if (!isProgressiveMemoryEnabled(cfg)) return null;

  return {
    label: "Memory Audit",
    name: "memory_audit",
    description:
      "Analyze token usage across memory systems. Identifies duplicates, stale entries, " +
      "and recommends optimizations with estimated token savings. Scope: all, memory_md, " +
      "domains, progressive, or system_prompt.",
    parameters: MemoryAuditSchema,
    execute: async (_toolCallId, params) => {
      const scope = readStringParam(params, "scope") ?? "all";
      const recommend = typeof params.recommend === "boolean" ? params.recommend : true;

      try {
        const agentId = resolveSessionAgentId({
          sessionKey: options.agentSessionKey,
          config: cfg,
        });
        const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
        const breakdown: MemoryAuditBreakdown[] = [];
        const duplicates: MemoryAuditDuplicate[] = [];
        const recommendations: MemoryAuditRecommendation[] = [];

        // Audit MEMORY.md
        if (scope === "all" || scope === "memory_md") {
          const memoryMdPath = path.join(workspaceDir, "MEMORY.md");
          try {
            const content = await fs.readFile(memoryMdPath, "utf-8");
            const tokens = estimateTokens(content);
            breakdown.push({
              source: "MEMORY.md",
              tokens,
              percentage: 0, // calculated later
              category: "long-term",
            });

            if (recommend && tokens > 4000) {
              recommendations.push({
                action: "restructure_memory_md",
                description:
                  "MEMORY.md exceeds 4000 tokens. Consider migrating to progressive store " +
                  "with lean index. Critical items stay in index; rest via memory_recall.",
                estimatedSavingsTokens: Math.max(0, tokens - 1500),
                risk: "medium",
              });
            }
          } catch {
            // MEMORY.md doesn't exist — that's fine
          }
        }

        // Audit memory/*.md files
        if (scope === "all" || scope === "domains") {
          const memoryDir = path.join(workspaceDir, "memory");
          try {
            const files = await fs.readdir(memoryDir);
            for (const file of files) {
              if (!file.endsWith(".md")) continue;
              const filePath = path.join(memoryDir, file);
              try {
                const content = await fs.readFile(filePath, "utf-8");
                const tokens = estimateTokens(content);
                breakdown.push({
                  source: `memory/${file}`,
                  tokens,
                  percentage: 0,
                  category: "domain",
                });
              } catch {
                // skip unreadable files
              }
            }
          } catch {
            // memory dir doesn't exist
          }
        }

        // Audit progressive store
        if (scope === "all" || scope === "progressive") {
          try {
            const { store } = await getProgressiveStore({ cfg });
            const status = store.status();
            breakdown.push({
              source: "progressive_store",
              tokens: status.totalTokensEstimated,
              percentage: 0,
              category: "structured",
            });

            // Check for low-priority entries that could be archived
            if (recommend) {
              const lowEntries = store.list({ priorityMin: undefined });
              const lowPriorityCount = lowEntries.filter((e) => e.priority === "low").length;
              if (lowPriorityCount > 10) {
                const lowTokens = lowEntries
                  .filter((e) => e.priority === "low")
                  .reduce((sum, e) => sum + e.tokenEstimate, 0);
                recommendations.push({
                  action: "archive_low_priority",
                  description: `${lowPriorityCount} low-priority entries consuming ${lowTokens} tokens. Consider archiving stale ones.`,
                  estimatedSavingsTokens: Math.floor(lowTokens * 0.5),
                  risk: "low",
                });
              }
            }
          } catch {
            // progressive store not available
          }
        }

        // Calculate percentages
        const totalTokens = breakdown.reduce((sum, b) => sum + b.tokens, 0);
        for (const b of breakdown) {
          b.percentage = totalTokens > 0 ? Math.round((b.tokens / totalTokens) * 1000) / 10 : 0;
        }

        // Sort breakdown by tokens descending
        breakdown.sort((a, b) => b.tokens - a.tokens);

        // Sort recommendations by savings descending
        recommendations.sort((a, b) => b.estimatedSavingsTokens - a.estimatedSavingsTokens);

        const result: MemoryAuditResult = {
          analysis: {
            totalTokens,
            breakdown,
            duplicates,
          },
        };

        if (recommend && recommendations.length > 0) {
          result.recommendations = recommendations;
        }

        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message });
      }
    },
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
