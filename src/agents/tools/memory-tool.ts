import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { listAgentIds, resolveAgentConfig, resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
  agent: Type.Optional(Type.String()),
  agents: Type.Optional(Type.Array(Type.String())),
  all: Type.Optional(Type.Boolean()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
  agent: Type.Optional(Type.String()),
});

type AllowedAgentInfo = {
  callerId: string;
  knownIds: Set<string>;
  allowAll: boolean;
  allowlist: Set<string>;
  allowedDisplay: string;
};

function resolveAllowedAgents(cfg: OpenClawConfig, callerId: string): AllowedAgentInfo {
  const knownIds = new Set(listAgentIds(cfg).map((id) => normalizeAgentId(id)));
  const rawAllowlist = resolveAgentConfig(cfg, callerId)?.memory?.allowReadFrom ?? [];
  const allowlist = new Set<string>();
  let allowAll = false;

  for (const entry of rawAllowlist) {
    const trimmed = String(entry ?? "").trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      allowAll = true;
      continue;
    }
    const normalized = normalizeAgentId(trimmed);
    if (knownIds.has(normalized)) {
      allowlist.add(normalized);
    }
  }

  const allowedDisplay = (() => {
    if (allowAll) {
      return "* (all other agents)";
    }
    if (allowlist.size > 0) {
      return Array.from(allowlist).join(", ");
    }
    return "none";
  })();

  return { callerId, knownIds, allowAll, allowlist, allowedDisplay };
}

function buildAllowedTargets(params: {
  callerId: string;
  knownIds: Set<string>;
  allowAll: boolean;
  allowlist: Set<string>;
  requested: {
    agent?: string;
    agents?: string[];
    all?: boolean;
  };
}): { ok: true; targets: string[] } | { ok: false; error: string } {
  const { requested, callerId, knownIds, allowAll, allowlist } = params;
  const hasAgent = Boolean(requested.agent);
  const hasAgents = Boolean(requested.agents && requested.agents.length > 0);
  const hasAll = requested.all === true;
  const selections = [hasAgent, hasAgents, hasAll].filter(Boolean).length;
  if (selections > 1) {
    return { ok: false, error: "Choose only one of agent, agents, or all." };
  }

  const normalizeRequested = (value: string) => normalizeAgentId(value);
  const unique = new Set<string>();
  let targets: string[] = [];

  if (hasAgent && requested.agent) {
    targets = [normalizeRequested(requested.agent)];
  } else if (hasAgents && requested.agents) {
    targets = requested.agents.map(normalizeRequested);
  } else if (hasAll) {
    if (!allowAll && allowlist.size === 0) {
      return { ok: false, error: "No allowed agents configured for all=true." };
    }
    const allTargets = allowAll
      ? Array.from(knownIds).filter((id) => id !== callerId)
      : Array.from(allowlist);
    targets = [callerId, ...allTargets];
  } else {
    targets = [callerId];
  }

  for (const target of targets) {
    if (!target) {
      continue;
    }
    if (target === callerId) {
      unique.add(target);
      continue;
    }
    if (!knownIds.has(target)) {
      return { ok: false, error: `Unknown agent id "${target}".` };
    }
    const allowed = allowAll || allowlist.has(target);
    if (!allowed) {
      return { ok: false, error: `Agent "${target}" is not allowed.` };
    }
    unique.add(target);
  }

  return { ok: true, targets: Array.from(unique) };
}

function buildAllowedAgentsLine(allowedDisplay: string): string {
  return `Allowed agents: ${allowedDisplay}. Self always allowed.`;
}

export function createMemorySearchTool(options: {
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
  const allowed = resolveAllowedAgents(cfg, agentId);
  return {
    label: "Memory Search",
    name: "memory_search",
    description: [
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
      "Use agent/agents/all to target other agents when allowed.",
      buildAllowedAgentsLine(allowed.allowedDisplay),
    ].join(" "),
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const agent = readStringParam(params, "agent");
      const agents = readStringArrayParam(params, "agents");
      const all = params.all === true;
      const targetsResult = buildAllowedTargets({
        callerId: agentId,
        knownIds: allowed.knownIds,
        allowAll: allowed.allowAll,
        allowlist: allowed.allowlist,
        requested: { agent, agents, all },
      });
      if (!targetsResult.ok) {
        return jsonResult({ results: [], disabled: true, error: targetsResult.error });
      }
      const targetIds = targetsResult.targets;
      const errors: Array<{ agentId: string; error: string }> = [];
      const results: Array<MemorySearchResult & { agentId: string }> = [];
      let firstStatus:
        | { provider?: string; model?: string; fallback?: unknown; mode?: string }
        | undefined = undefined;
      try {
        const citationsMode = resolveMemoryCitationsMode(cfg);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });
        for (const targetId of targetIds) {
          const { manager, error } = await getMemorySearchManager({
            cfg,
            agentId: targetId,
          });
          if (!manager) {
            errors.push({ agentId: targetId, error: error ?? "memory unavailable" });
            continue;
          }
          const rawResults = await manager.search(query, {
            maxResults,
            minScore,
            sessionKey: options.agentSessionKey,
          });
          const status = manager.status();
          if (!firstStatus) {
            const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
            firstStatus = {
              provider: status.provider,
              model: status.model,
              fallback: status.fallback,
              mode: searchMode,
            };
          }
          const decorated = decorateCitations(rawResults, includeCitations);
          const resolved = resolveMemoryBackendConfig({ cfg, agentId: targetId });
          const clamped =
            status.backend === "qmd"
              ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
              : decorated;
          for (const entry of clamped) {
            results.push({ ...entry, agentId: targetId });
          }
        }
        if (results.length === 0 && errors.length > 0) {
          return jsonResult(
            buildMemorySearchUnavailableResult(
              errors.map((entry) => `${entry.agentId}: ${entry.error}`).join("; "),
            ),
          );
        }
        const sorted = results.toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const limited =
          typeof maxResults === "number" && Number.isFinite(maxResults)
            ? sorted.slice(0, maxResults)
            : sorted;
        return jsonResult({
          results: limited,
          ...firstStatus,
          citations: citationsMode,
          ...(errors.length > 0 ? { errors } : {}),
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
  const allowed = resolveAllowedAgents(cfg, agentId);
  return {
    label: "Memory Get",
    name: "memory_get",
    description: [
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
      "Use agent to target other agents when allowed.",
      buildAllowedAgentsLine(allowed.allowedDisplay),
    ].join(" "),
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const relPath = readStringParam(params, "path", { required: true });
      const from = readNumberParam(params, "from", { integer: true });
      const lines = readNumberParam(params, "lines", { integer: true });
      const target = readStringParam(params, "agent");
      const targetsResult = buildAllowedTargets({
        callerId: agentId,
        knownIds: allowed.knownIds,
        allowAll: allowed.allowAll,
        allowlist: allowed.allowlist,
        requested: { agent: target },
      });
      if (!targetsResult.ok) {
        return jsonResult({
          path: relPath,
          text: "",
          disabled: true,
          error: targetsResult.error,
        });
      }
      const targetId = targetsResult.targets[0] ?? agentId;
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId: targetId,
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
