/**
 * memory_recall — MCP tool for smart structured memory retrieval.
 *
 * Part of the Progressive Memory System. Retrieves categorized entries
 * with semantic search, priority filtering, and token budget awareness.
 *
 * Falls back to memory_search for queries with no progressive results.
 * This is ADDITIVE — it never touches memory_search or memory_get.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  MemoryCategory,
  MemoryPriority,
  MemoryRecallEntry,
} from "../../memory/progressive-types.js";
import type { AnyAgentTool } from "./common.js";
import { getProgressiveStore } from "../../memory/progressive-manager.js";
import { PRIORITY_ORDER } from "../../memory/progressive-types.js";
import { jsonResult, readStringParam, readStringArrayParam, readNumberParam } from "./common.js";

/** Approximate chars per token for budget calculations. */
const CHARS_PER_TOKEN = 4;

const MemoryRecallSchema = Type.Object({
  query: Type.String({ description: "Natural language query for memory recall" }),
  categories: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.String()], {
      description:
        'Filter by categories: "preference" | "instruction" | "fact" | "project" | "person" | "decision" | "insight"',
    }),
  ),
  priority_min: Type.Optional(
    Type.String({
      description: 'Minimum priority to include: "critical" | "high" | "medium" | "low"',
    }),
  ),
  token_budget: Type.Optional(Type.Number({ description: "Max tokens to return (default: 3000)" })),
  include_context: Type.Optional(
    Type.Boolean({ description: "Include storage context (default: false)" }),
  ),
  format: Type.Optional(
    Type.String({ description: 'Output verbosity: "brief" | "detailed" (default: "brief")' }),
  ),
});

export function createMemoryRecallTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  if (!isProgressiveMemoryEnabled(cfg)) return null;

  return {
    label: "Memory Recall",
    name: "memory_recall",
    description:
      "Smart retrieval from structured memory store. Combines semantic and full-text search " +
      "with category filtering and token budget awareness. Returns categorized entries ranked " +
      "by relevance. Use memory_search for raw file-based search; use this for structured queries.",
    parameters: MemoryRecallSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const categories = readStringArrayParam(params, "categories") as MemoryCategory[] | undefined;
      const priorityMin = readStringParam(params, "priority_min") as MemoryPriority | undefined;
      const tokenBudget = readNumberParam(params, "token_budget") ?? 3000;
      const includeContext =
        typeof params.include_context === "boolean" ? params.include_context : false;
      const format = (readStringParam(params, "format") ?? "brief") as "brief" | "detailed";

      try {
        const { store, embedFn } = await getProgressiveStore({ cfg });

        // Archive expired entries opportunistically
        store.archiveExpired();

        // Update last_recall timestamp
        // (done via meta in the store)

        // Generate embedding for the query
        let queryEmbedding: number[] | undefined;
        if (embedFn) {
          try {
            queryEmbedding = await embedFn(query);
          } catch {
            // Fall back to FTS-only
          }
        }

        // Perform hybrid search
        const results = await store.searchHybrid(query, queryEmbedding, {
          categories,
          priorityMin,
          limit: 50, // Get extra for budget trimming
        });

        // Apply token budget
        let tokenCount = 0;
        const budgetedEntries: MemoryRecallEntry[] = [];

        for (const entry of results) {
          const entryTokens = estimateEntryTokens(entry, includeContext, format);
          if (tokenCount + entryTokens > tokenBudget && budgetedEntries.length > 0) {
            break;
          }
          budgetedEntries.push({
            id: entry.id,
            category: entry.category,
            content: format === "brief" ? truncateContent(entry.content, 200) : entry.content,
            context: includeContext ? entry.context : undefined,
            priority: entry.priority,
            score: Math.round(entry.score * 1000) / 1000,
            storedAt: entry.createdAt,
            tags: entry.tags,
          });
          tokenCount += entryTokens;
        }

        return jsonResult({
          entries: budgetedEntries,
          tokenCount,
          budgetRemaining: Math.max(0, tokenBudget - tokenCount),
          totalEntriesMatched: results.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          entries: [],
          tokenCount: 0,
          budgetRemaining: tokenBudget,
          error: message,
        });
      }
    },
  };
}

function estimateEntryTokens(
  entry: { content: string; context?: string },
  includeContext: boolean,
  format: "brief" | "detailed",
): number {
  const contentLen =
    format === "brief"
      ? Math.min(entry.content.length, 800) // brief truncates
      : entry.content.length;
  const contextLen = includeContext && entry.context ? entry.context.length : 0;
  const overhead = 50; // JSON structure, metadata
  return Math.ceil((contentLen + contextLen + overhead) / CHARS_PER_TOKEN);
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "…";
}

function isProgressiveMemoryEnabled(cfg: OpenClawConfig): boolean {
  const memory = cfg.memory as Record<string, unknown> | undefined;
  if (!memory) return false;
  const progressive = memory.progressive as Record<string, unknown> | undefined;
  return progressive?.enabled === true;
}
