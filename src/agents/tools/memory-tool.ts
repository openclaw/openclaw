import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { MemorySearchResult } from "../../memory/types.js";
import type { AnyAgentTool } from "./common.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { hasWriteCapability } from "../../memory/mongodb-manager.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
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
  const isMongoDBBackend = cfg.memory?.backend === "mongodb";
  const description = isMongoDBBackend
    ? 'Mandatory recall step: semantically search your knowledge base, structured memory, memory files, and session transcripts. Returns top snippets with source, path, and relevance score. Use for any question about prior work, decisions, dates, people, preferences, or todos. Example: memory_search({query: "what auth approach did we decide on?"})'
    : "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.";
  return {
    label: "Memory Search",
    name: "memory_search",
    description,
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ results: [], disabled: true, error });
      }
      try {
        const citationsMode = resolveMemoryCitationsMode(cfg);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });
        const rawResults = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
        });
        const status = manager.status();
        const decorated = decorateCitations(rawResults, includeCitations);
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        const results =
          status.backend === "qmd"
            ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
            : decorated;
        const feedbackHint = computeFeedbackHint(
          rawResults,
          isMongoDBBackend ? "mongodb" : status.backend,
        );
        return jsonResult({
          results,
          provider: status.provider,
          model: status.model,
          fallback: status.fallback,
          citations: citationsMode,
          ...(feedbackHint ? { feedbackHint } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], disabled: true, error: message });
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

// ---------------------------------------------------------------------------
// Feedback loop: low-confidence hint for memory_search results
// ---------------------------------------------------------------------------

const FEEDBACK_MIN_RESULTS = 2;
const FEEDBACK_MAX_SCORE = 0.3;

/**
 * Compute a feedback hint when memory_search returns low-confidence results.
 * Triggers when: results.length < 2 AND all scores < 0.3 (MongoDB backend only).
 * Returns undefined when results are confident enough or backend is not MongoDB.
 */
export function computeFeedbackHint(
  results: MemorySearchResult[],
  backend: string | undefined,
): string | undefined {
  if (backend !== "mongodb") {
    return undefined;
  }
  // Low confidence: fewer than 2 results AND all scores below threshold
  if (results.length >= FEEDBACK_MIN_RESULTS) {
    return undefined;
  }
  const allLowScore = results.every((r) => (r.score ?? 0) < FEEDBACK_MAX_SCORE);
  if (!allLowScore) {
    return undefined;
  }
  return "Low confidence results. Consider rephrasing your query or checking kb_search for reference documents.";
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

// ---------------------------------------------------------------------------
// KB Search Tool (MongoDB-only, registered when MongoDB backend is active)
// ---------------------------------------------------------------------------

const KBSearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  // TODO: Add tags/category filtering once searchKB supports direct filter params
});

export function createKBSearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  // Only register when MongoDB backend is active
  if (cfg.memory?.backend !== "mongodb") {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "KB Search",
    name: "kb_search",
    description:
      'Search the knowledge base for imported documents, FAQs, architecture specs, and reference materials. Returns matching snippets with source and relevance score. Use for factual/reference lookups when you need specific documentation rather than general memory recall. Example: kb_search({query: "API rate limiting policy"})',
    parameters: KBSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults") ?? 5;

      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        return jsonResult({ results: [], disabled: true, error });
      }

      try {
        // Use the manager's search with KB-specific filtering via the query
        // The enhanced search() in MongoDBMemoryManager already searches KB
        const results = await manager.search(query, { maxResults });
        // Filter to KB results only
        const kbResults = results.filter((r) => r.source === "kb");
        return jsonResult({ results: kbResults });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], disabled: true, error: message });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Memory Write Tool (MongoDB-only, registered when MongoDB backend is active)
// ---------------------------------------------------------------------------

const MemoryWriteSchema = Type.Object({
  type: Type.Union([
    Type.Literal("decision"),
    Type.Literal("preference"),
    Type.Literal("person"),
    Type.Literal("todo"),
    Type.Literal("fact"),
    Type.Literal("project"),
    Type.Literal("architecture"),
    Type.Literal("custom"),
  ]),
  key: Type.String(),
  value: Type.String(),
  context: Type.Optional(Type.String()),
  confidence: Type.Optional(Type.Number()),
  tags: Type.Optional(Type.Array(Type.String())),
});

export function createMemoryWriteTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  // Only register when MongoDB backend is active
  if (cfg.memory?.backend !== "mongodb") {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Memory Write",
    name: "memory_write",
    description:
      'Store a structured observation in persistent memory. Types: decision (choices made), preference (user likes/dislikes), fact (objective info), person (people info), todo (action items), project (project-level context), architecture (technical decisions), custom (anything else). Type+key is the dedup key: writing the same type+key updates the existing record. Set confidence 0.0-1.0 to express certainty. Use for important information; use MEMORY.md for informal scratch notes. Example: memory_write({type: "decision", key: "auth-method", value: "OAuth2 with PKCE"})',
    parameters: MemoryWriteSchema,
    execute: async (_toolCallId, params) => {
      const type = readStringParam(params, "type", { required: true });
      const key = readStringParam(params, "key", { required: true });
      const value = readStringParam(params, "value", { required: true });
      const context = readStringParam(params, "context");
      const confidence = readNumberParam(params, "confidence");
      const tags =
        params && typeof params === "object" && "tags" in params
          ? ((params as Record<string, unknown>).tags as string[] | undefined)
          : undefined;

      try {
        // Reuse the manager's existing connection pool (not per-call MongoClient)
        const { manager, error } = await getMemorySearchManager({ cfg, agentId });
        if (!manager) {
          return jsonResult({ success: false, error: error ?? "memory manager unavailable" });
        }
        if (!hasWriteCapability(manager)) {
          return jsonResult({ success: false, error: "write not supported on this backend" });
        }

        const result = await manager.writeStructuredMemory({
          type: type as import("../../memory/mongodb-structured-memory.js").StructuredMemoryType,
          key,
          value,
          context: context ?? undefined,
          confidence: confidence ?? 0.8,
          source: "agent",
          agentId,
          tags: tags ?? undefined,
        });

        return jsonResult({
          success: true,
          upserted: result.upserted,
          id: result.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },
  };
}
