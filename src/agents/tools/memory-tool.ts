import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
  startDate: Type.Optional(Type.String({ description: "Start date filter (YYYY-MM-DD)" })),
  endDate: Type.Optional(Type.String({ description: "End date filter (YYYY-MM-DD)" })),
  sector: Type.Optional(
    Type.String({
      description: "Filter by sector: semantic, procedural, episodic, emotional, reflective",
    }),
  ),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

function resolveMemoryToolContext(options: { config?: OpenClawConfig; agentSessionKey?: string }) {
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
  return { cfg, agentId };
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const startDate = readStringParam(params, "startDate");
      const endDate = readStringParam(params, "endDate");
      const sector = readStringParam(params, "sector");
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult(buildMemorySearchUnavailableResult(error));
      }
      try {
        const citationsMode = resolveMemoryCitationsMode(cfg);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });

        // Build temporal filter for OpenMemory backend
        const backendConfig = resolveMemoryBackendConfig({ cfg, agentId });
        let temporal: { startTime?: number; endTime?: number; sector?: string } | undefined;
        if (backendConfig.backend === "openmemory") {
          if (startDate || endDate || sector) {
            temporal = {};
            if (startDate) {
              temporal.startTime = new Date(startDate).getTime();
            }
            if (endDate) {
              temporal.endTime = new Date(endDate + "T23:59:59").getTime(); // End of day
            }
            if (sector) {
              temporal.sector = sector as
                | "semantic"
                | "procedural"
                | "episodic"
                | "emotional"
                | "reflective";
            }
          }
        }

        const rawResults = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
          temporal,
        });
        const status = manager.status();
        const decorated = decorateCitations(rawResults, includeCitations);
        // Re-use backendConfig from above for QMD limits
        const results =
          status.backend === "qmd"
            ? clampResultsByInjectedChars(decorated, backendConfig.qmd?.limits.maxInjectedChars)
            : decorated;
        const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
        return jsonResult({
          results,
          provider: status.provider,
          model: status.model,
          fallback: status.fallback,
          citations: citationsMode,
          mode: searchMode,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult(buildMemorySearchUnavailableResult(message));
      }
    },
  };
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const relPath = readStringParam(params, "path", { required: true });
      const from = readNumberParam(params, "from", { integer: true });
      const lines = readNumberParam(params, "lines", { integer: true });
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ path: relPath, text: "", disabled: true, error });
      }
      try {
        const result = await manager.readFile({
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
        });
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ path: relPath, text: "", disabled: true, error: message });
      }
    },
  };
}

function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function clampResultsByInjectedChars(
  results: MemorySearchResult[],
  budget?: number,
): MemorySearchResult[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: MemorySearchResult[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
}

function buildMemorySearchUnavailableResult(error: string | undefined) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const isQuotaError = /insufficient_quota|quota|429/.test(reason.toLowerCase());
  const warning = isQuotaError
    ? "Memory search is unavailable because the embedding provider quota is exhausted."
    : "Memory search is unavailable due to an embedding/provider error.";
  const action = isQuotaError
    ? "Top up or switch embedding provider, then retry memory_search."
    : "Check embedding provider configuration and retry memory_search.";
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
  };
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  // auto: show citations in direct chats; suppress in groups/channels by default.
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}

const MemoryAddSchema = Type.Object({
  content: Type.String({ description: "The memory content to store" }),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: "Optional tags for categorization" }),
  ),
  sector: Type.Optional(
    Type.String({
      description: "Optional sector hint: episodic, semantic, procedural, emotional, reflective",
    }),
  ),
});

/**
 * Create memory_add tool for writing memories to OpenMemory
 */
export function createMemoryAddTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  // Check if OpenMemory backend is configured
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const resolved = resolveMemoryBackendConfig({ cfg, agentId });
  if (resolved.backend !== "openmemory" || !resolved.openmemory) {
    // Only enable memory_add when OpenMemory is the backend
    return null;
  }

  return {
    label: "Memory Add",
    name: "memory_add",
    description:
      "Store a durable memory in OpenMemory. Use for facts, decisions, preferences, or events worth remembering long-term. OpenMemory auto-classifies into sectors (semantic/procedural/episodic/emotional/reflective) and manages decay.",
    parameters: MemoryAddSchema,
    execute: async (_toolCallId, params) => {
      const content = readStringParam(params, "content", { required: true });
      const tags = (params as Record<string, unknown>).tags as string[] | undefined;
      const sector = readStringParam(params, "sector");

      try {
        // Dynamically import to avoid circular dependencies
        const { OpenMemoryClient } = await import("../../memory/openmemory-client.js");
        const client = await OpenMemoryClient.create(resolved.openmemory!);

        if (!client) {
          return jsonResult({
            ok: false,
            error: "OpenMemory server unavailable",
          });
        }

        const result = await client.add({
          content,
          tags,
          metadata: {
            source: "agent",
            date: new Date().toISOString().split("T")[0],
            sessionKey: options.agentSessionKey,
            sectorHint: sector,
          },
        });

        return jsonResult({
          ok: true,
          id: result.id,
          sector: result.primary_sector,
          sectors: result.sectors,
          salience: result.salience,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          ok: false,
          error: message,
        });
      }
    },
  };
}

const MemoryRelatedSchema = Type.Object({
  memoryId: Type.String({ description: "The memory ID to find related memories for" }),
  maxResults: Type.Optional(
    Type.Number({ description: "Maximum number of related memories to return" }),
  ),
});

/**
 * Create memory_related tool for finding related memories via waypoint graph
 */
export function createMemoryRelatedTool(options: {
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
  const resolved = resolveMemoryBackendConfig({ cfg, agentId });
  if (resolved.backend !== "openmemory" || !resolved.openmemory) {
    return null;
  }

  return {
    label: "Memory Related",
    name: "memory_related",
    description:
      "Find memories related to a given memory via the waypoint graph. Use to discover connections, patterns, and related context. Returns memories that were mentioned or occurred near the same time.",
    parameters: MemoryRelatedSchema,
    execute: async (_toolCallId, params) => {
      const memoryId = readStringParam(params, "memoryId", { required: true });
      const maxResults = readNumberParam(params, "maxResults");

      try {
        const { OpenMemoryClient } = await import("../../memory/openmemory-client.js");
        const client = await OpenMemoryClient.create(resolved.openmemory!);

        if (!client) {
          return jsonResult({
            ok: false,
            error: "OpenMemory server unavailable",
          });
        }

        const related = await client.related(memoryId, maxResults);

        return jsonResult({
          ok: true,
          source: memoryId,
          count: related.length,
          related: related.map((r) => ({
            id: r.id,
            content: r.content.slice(0, 200) + (r.content.length > 200 ? "..." : ""),
            weight: r.weight,
            sector: r.primary_sector,
            salience: r.salience,
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          ok: false,
          error: message,
        });
      }
    },
  };
}
