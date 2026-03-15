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
  query: Type.String({ description: "Natural-language search query for semantic memory lookup." }),
  maxResults: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 50,
      description:
        "Max snippets to return. Default: backend-defined. Keep low (5-10) to avoid bloating context.",
    }),
  ),
  minScore: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description:
        "Minimum relevance score (0-1). Higher values return fewer but more relevant results.",
    }),
  ),
});

const MemoryGetSchema = Type.Object({
  path: Type.String({
    description: 'Relative path within memory directory (e.g. "MEMORY.md" or "memory/topic.md").',
  }),
  from: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Starting line number (1-based). Omit to read from the beginning.",
    }),
  ),
  lines: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 500,
      description:
        "Number of lines to read. Default: entire file. Keep small to avoid bloating context.",
    }),
  ),
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

async function getMemoryManagerContext(params: { cfg: OpenClawConfig; agentId: string }): Promise<
  | {
      manager: NonNullable<Awaited<ReturnType<typeof getMemorySearchManager>>["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  const { manager, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return manager ? { manager } : { error };
}

function createMemoryTool(params: {
  options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
  };
  label: string;
  name: string;
  description: string;
  parameters: typeof MemorySearchSchema | typeof MemoryGetSchema;
  execute: (ctx: { cfg: OpenClawConfig; agentId: string }) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.label,
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    execute: params.execute(ctx),
  };
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readNumberParam(params, "maxResults");
        const minScore = readNumberParam(params, "minScore");
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult(buildMemorySearchUnavailableResult(memory.error));
        }
        try {
          const citationsMode = resolveMemoryCitationsMode(cfg);
          const includeCitations = shouldIncludeCitations({
            mode: citationsMode,
            sessionKey: options.agentSessionKey,
          });
          const rawResults = await memory.manager.search(query, {
            maxResults,
            minScore,
            sessionKey: options.agentSessionKey,
          });
          const status = memory.manager.status();
          const decorated = decorateCitations(rawResults, includeCitations);
          const resolved = resolveMemoryBackendConfig({ cfg, agentId });
          const results =
            status.backend === "qmd"
              ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
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
  });
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const relPath = readStringParam(params, "path", { required: true });
        const from = readNumberParam(params, "from", { integer: true });
        const lines = readNumberParam(params, "lines", { integer: true });
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({ path: relPath, text: "", disabled: true, error: memory.error });
        }
        try {
          const result = await memory.manager.readFile({
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
  });
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
