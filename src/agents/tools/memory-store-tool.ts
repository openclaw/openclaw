/**
 * memory_store — MCP tool for structured memory writes.
 *
 * Part of the Progressive Memory System. Writes categorized, prioritized entries
 * to the progressive store with deduplication and token tracking.
 *
 * This is ADDITIVE — it never touches memory_search or memory_get.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  MemoryCategory,
  MemoryPriority,
  MemorySource,
} from "../../memory/progressive-types.js";
import type { AnyAgentTool } from "./common.js";
import {
  getProgressiveStore,
  type ProgressiveStoreAccess,
} from "../../memory/progressive-manager.js";
import { ProgressiveMemoryStore, type EmbedFn } from "../../memory/progressive-store.js";
import { VALID_CATEGORIES, VALID_PRIORITIES } from "../../memory/progressive-types.js";
import { jsonResult, readStringParam, readStringArrayParam } from "./common.js";

const MemoryStoreSchema = Type.Object({
  category: Type.String({
    description:
      'Memory category: "preference" | "instruction" | "fact" | "project" | "person" | "decision" | "insight"',
  }),
  content: Type.String({ description: "The memory content to store" }),
  context: Type.Optional(
    Type.String({ description: "Why this is being stored (for future relevance)" }),
  ),
  priority: Type.Optional(
    Type.String({
      description: 'Priority tier: "critical" | "high" | "medium" | "low" (default: "medium")',
    }),
  ),
  tags: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.String()], {
      description: "Freeform tags for cross-referencing",
    }),
  ),
  related_to: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.String()], {
      description: "IDs of related memory entries",
    }),
  ),
  source: Type.Optional(
    Type.String({
      description:
        'Source: "session" | "manual" | "migration" | "consolidation" (default: "manual")',
    }),
  ),
  expires: Type.Optional(Type.String({ description: "ISO 8601 expiry date for auto-archive" })),
});

export function createMemoryStoreTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  // Check if progressive memory is enabled
  if (!isProgressiveMemoryEnabled(cfg)) return null;

  return {
    label: "Memory Store",
    name: "memory_store",
    description:
      "Store a structured memory entry with category, priority, and tags. " +
      "Automatically deduplicates similar content. Use for persisting facts, preferences, " +
      "instructions, decisions, and insights. Returns entry ID and token cost.",
    parameters: MemoryStoreSchema,
    execute: async (_toolCallId, params) => {
      const category = readStringParam(params, "category", { required: true }) as MemoryCategory;
      const content = readStringParam(params, "content", { required: true });
      const context = readStringParam(params, "context");
      const priority = readStringParam(params, "priority") as MemoryPriority | undefined;
      const tags = readStringArrayParam(params, "tags");
      const relatedTo = readStringArrayParam(params, "related_to");
      const source = readStringParam(params, "source") as MemorySource | undefined;
      const expires = readStringParam(params, "expires");

      try {
        const { store, embedFn } = await getProgressiveStore({ cfg });

        // Archive any expired entries opportunistically
        store.archiveExpired();

        const result = await store.store(
          {
            category,
            content,
            context,
            priority,
            tags,
            relatedTo,
            source,
            expires,
          },
          embedFn,
        );

        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ stored: false, error: message });
      }
    },
  };
}

function isProgressiveMemoryEnabled(cfg: OpenClawConfig): boolean {
  // Check config for progressive memory flag
  const memory = cfg.memory as Record<string, unknown> | undefined;
  if (!memory) return false;
  const progressive = memory.progressive as Record<string, unknown> | undefined;
  return progressive?.enabled === true;
}
