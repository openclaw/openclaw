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
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  mode: Type.Optional(
    Type.Union([Type.Literal("hybrid"), Type.Literal("vector"), Type.Literal("keyword")]),
  ),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
  sessionScope: Type.Optional(
    Type.Union([Type.Literal("session"), Type.Literal("actor"), Type.Literal("global")]),
  ),
  actorType: Type.Optional(Type.Union([Type.Literal("human"), Type.Literal("agent")])),
  actorId: Type.Optional(Type.String()),
  role: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("system")]),
  ),
});

const MemoryRecallSchema = Type.Object({
  query: Type.String(),
  mode: Type.Optional(
    Type.Union([Type.Literal("hybrid"), Type.Literal("vector"), Type.Literal("keyword")]),
  ),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
  timeWindowHours: Type.Optional(Type.Number()),
  sessionScope: Type.Optional(
    Type.Union([Type.Literal("session"), Type.Literal("actor"), Type.Literal("global")]),
  ),
  actorType: Type.Optional(Type.Union([Type.Literal("human"), Type.Literal("agent")])),
  actorId: Type.Optional(Type.String()),
  role: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("system")]),
  ),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

type ActorContext = {
  actorId?: string;
  actorType?: "human" | "agent";
  chatType?: string;
};

function isSharedContextQuery(query: string): boolean {
  const lower = query.toLowerCase();
  const tokens = [
    "we",
    "our",
    "us",
    "team",
    "group",
    "everyone",
    "anyone",
    "all",
    "channel",
    "server",
    "thread",
    "guild",
    "room",
    "together",
    "others",
    "people",
  ];
  return tokens.some((token) => new RegExp(`\\b${token}\\b`, "i").test(lower));
}

function resolveActorContext(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
}): ActorContext {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return {};
  }
  const storePath = resolveStorePath(params.config.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return {};
  }
  const channel =
    entry.origin?.provider?.trim() || entry.channel?.trim() || entry.lastChannel?.trim();
  const rawUserId =
    entry.origin?.from?.trim() || entry.deliveryContext?.to?.trim() || entry.lastTo?.trim();
  const actorId =
    channel && rawUserId && !rawUserId.includes(":") ? `${channel}:${rawUserId}` : rawUserId;
  return {
    actorId: actorId || undefined,
    actorType: actorId ? "human" : undefined,
    chatType: entry.chatType,
  };
}

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
      "Mandatory recall step: search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; supports vector/keyword/hybrid modes plus session/actor filters; returns top snippets with path + lines.",
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
        return jsonResult(buildMemorySearchUnavailableResult(error));
      }
      try {
        const mode = readStringParam(params, "mode");
        const sessionScope = readStringParam(params, "sessionScope");
        const actorType = readStringParam(params, "actorType");
        const actorId = readStringParam(params, "actorId");
        const role = readStringParam(params, "role");
        const actorContext = resolveActorContext({
          config: cfg,
          agentId,
          sessionKey: options.agentSessionKey,
        });
        const sharedContext = isSharedContextQuery(query);
        const isGroupChat =
          actorContext.chatType && actorContext.chatType !== "direct";
        const autoActorScope =
          !sessionScope &&
          !actorId &&
          !actorType &&
          actorContext.actorId &&
          !isGroupChat &&
          !sharedContext;
        const resolvedScope =
          sessionScope ??
          (autoActorScope ? "actor" : sharedContext && !isGroupChat ? "global" : "session");
        const resolvedActorId = actorId ?? (autoActorScope ? actorContext.actorId : undefined);
        const resolvedActorType = actorType ?? (autoActorScope ? actorContext.actorType : undefined);
        
        // Log search parameters for debugging and security auditing
        const memorySearchLog = createSubsystemLogger("memory-search");
        memorySearchLog.debug(
          `memory_search: query="${query.substring(0, 100)}${query.length > 100 ? "..." : ""}" ` +
            `sessionKey=${options.agentSessionKey ?? "none"} chatType=${actorContext.chatType ?? "unknown"} ` +
            `isGroupChat=${isGroupChat} sessionScope=${resolvedScope} ` +
            `actorId=${resolvedActorId ?? "none"} actorType=${resolvedActorType ?? "none"} ` +
            `mode=${mode ?? "hybrid"} maxResults=${maxResults ?? "default"} minScore=${minScore ?? "default"}`,
        );
        
        const results = await manager.search(query, {
          mode: mode as "hybrid" | "vector" | "keyword" | undefined,
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
          sessionScope: resolvedScope as "session" | "actor" | "global" | undefined,
          actorType: resolvedActorType,
          actorId: resolvedActorId,
          role,
        });
        
        if (results && results.length > 0) {
          const sources = new Set(results.map((r) => r.source));
          memorySearchLog.debug(
            `memory_search: found ${results.length} results from sources: ${Array.from(sources).join(", ")} ` +
              `sessionKey=${options.agentSessionKey ?? "none"} sessionScope=${resolvedScope}`,
          );
        }
        
        const status = manager.status();
        const decorated = decorateCitations(results, includeCitations);
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        const finalResults =
          status.backend === "qmd"
            ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
            : decorated;
        const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
        return jsonResult({
          results: finalResults,
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

export function createMemoryRecallTool(options: {
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
    label: "Memory Recall",
    name: "memory_recall",
    description:
      "Recall from Postgres memory store with optional time window and actor filters; supports vector/keyword/hybrid modes.",
    parameters: MemoryRecallSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const mode = readStringParam(params, "mode");
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const timeWindowHours = readNumberParam(params, "timeWindowHours");
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ results: [], disabled: true, error });
      }
      try {
        const sessionScope = readStringParam(params, "sessionScope");
        const actorType = readStringParam(params, "actorType");
        const actorId = readStringParam(params, "actorId");
        const role = readStringParam(params, "role");
        const actorContext = resolveActorContext({
          config: cfg,
          agentId,
          sessionKey: options.agentSessionKey,
        });
        const resolvedScope =
          sessionScope ??
          (actorContext.actorId ? "actor" : "session");
        const resolvedActorId = actorId ?? actorContext.actorId ?? undefined;
        const resolvedActorType = actorType ?? actorContext.actorType ?? undefined;
        const now = Date.now();
        const updatedAfter =
          typeof timeWindowHours === "number" && Number.isFinite(timeWindowHours) && timeWindowHours > 0
            ? now - Math.round(timeWindowHours * 60 * 60 * 1000)
            : undefined;
        
        // Log search parameters for debugging and security auditing
        const memoryRecallLog = createSubsystemLogger("memory-recall");
        const isGroupChat = actorContext.chatType && actorContext.chatType !== "direct";
        memoryRecallLog.debug(
          `memory_recall: query="${query.substring(0, 100)}${query.length > 100 ? "..." : ""}" ` +
            `sessionKey=${options.agentSessionKey ?? "none"} chatType=${actorContext.chatType ?? "unknown"} ` +
            `isGroupChat=${isGroupChat} sessionScope=${resolvedScope} ` +
            `actorId=${resolvedActorId ?? "none"} actorType=${resolvedActorType ?? "none"} ` +
            `timeWindowHours=${timeWindowHours ?? "none"} mode=${mode ?? "hybrid"}`,
        );
        
        const results = await manager.search(query, {
          mode: mode as "hybrid" | "vector" | "keyword" | undefined,
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
          sessionScope: resolvedScope as "session" | "actor" | "global" | undefined,
          actorType: resolvedActorType,
          actorId: resolvedActorId,
          role,
          updatedAfter,
        });
        
        if (results && results.length > 0) {
          const sources = new Set(results.map((r) => r.source));
          memoryRecallLog.debug(
            `memory_recall: found ${results.length} results from sources: ${Array.from(sources).join(", ")} ` +
              `sessionKey=${options.agentSessionKey ?? "none"} sessionScope=${resolvedScope}`,
          );
        }
        return jsonResult({ results, updatedAfter });
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
