import { randomUUID } from "node:crypto";
import { listAgentIds } from "../../agents/agent-scope.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  MemoryProviderStatus,
  MemorySearchResult,
  MemorySource,
} from "../../memory-host-sdk/host/types.js";
import { getActiveMemorySearchManager } from "../../plugins/memory-runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { loadSessionEntry } from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type RecordLike = Record<string, unknown>;

type MemoryScope = {
  requesterAgentId: string;
  allowedAgentIds: string[];
  crossAgent: boolean;
};

type MemoryIndexJob = {
  jobId: string;
  requesterAgentId: string;
  agentIds: string[];
  status: "running" | "completed" | "failed";
  force: boolean;
  reason: string;
  createdAtMs: number;
  updatedAtMs: number;
  error?: string;
  progress?: { completed: number; total: number; label?: string };
};

type MemorySourceRef = {
  sourceRef: string;
  requesterAgentId: string;
  agentId: string;
  path: string;
  source?: MemorySource;
  startLine?: number;
  endLine?: number;
  issuedAtMs: number;
  expiresAtMs: number;
};

const SOURCE_REF_TTL_MS = 10 * 60 * 1000;
const sourceRefs = new Map<string, MemorySourceRef>();
const indexJobs = new Map<string, MemoryIndexJob>();

function asRecord(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : {};
}

function stringParam(params: RecordLike, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberParam(params: RecordLike, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolParam(params: RecordLike, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function rejectUnexpectedParams(
  params: RecordLike,
  allowed: string[],
  respond: RespondFn,
): boolean {
  const allowedSet = new Set(allowed);
  const forbidden = ["agentId", "agent_id", "allAgents", "bypassScope", "path", "absolutePath"];
  for (const key of Object.keys(params)) {
    if (forbidden.includes(key) || !allowedSet.has(key)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported memory RPC param: ${key}`),
      );
      return true;
    }
  }
  return false;
}

function normalizeAgentIdValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed ? normalizeAgentId(trimmed) : undefined;
}

function normalizeAgentIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(normalizeAgentIdValue).filter((id): id is string => Boolean(id)))];
}

function resolveMemoryCoreSearchScopeConfig(cfg: OpenClawConfig): RecordLike {
  const entry = asRecord(cfg.plugins?.entries?.["memory-core"]);
  const pluginConfig = asRecord(entry.config);
  return asRecord(pluginConfig.searchScope);
}

function resolveMemoryRpcScope(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
}): MemoryScope {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const scopeConfig = resolveMemoryCoreSearchScopeConfig(params.cfg);
  const configuredChiefIds = normalizeAgentIdList(scopeConfig.chiefAgentIds);
  const chiefAgentIds = configuredChiefIds.length > 0 ? configuredChiefIds : ["chief"];
  const isChief = chiefAgentIds.includes(requesterAgentId);
  if (!isChief || scopeConfig.chiefCrossAgent === false) {
    return { requesterAgentId, allowedAgentIds: [requesterAgentId], crossAgent: false };
  }

  const configuredIds = listAgentIds(params.cfg).map((id) => normalizeAgentId(id));
  const allowlist = normalizeAgentIdList(scopeConfig.allowedAgentIds);
  const allowedAgentIds =
    allowlist.length > 0
      ? allowlist.filter((agentId) => configuredIds.length === 0 || configuredIds.includes(agentId))
      : configuredIds;
  const effectiveAllowed = allowedAgentIds.length > 0 ? allowedAgentIds : [requesterAgentId];
  return {
    requesterAgentId,
    allowedAgentIds: effectiveAllowed,
    crossAgent: effectiveAllowed.some((agentId) => agentId !== requesterAgentId),
  };
}

function resolveRequesterContext(params: RecordLike, respond: RespondFn) {
  const sessionKey = stringParam(params, "sessionKey");
  if (!sessionKey) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "memory RPC requires sessionKey"),
    );
    return null;
  }
  const loaded = loadSessionEntry(sessionKey);
  if (!loaded.entry) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session key "${sessionKey}"`),
    );
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: loaded.canonicalKey ?? sessionKey,
    config: loaded.cfg,
  });
  const scope = resolveMemoryRpcScope({ cfg: loaded.cfg, requesterAgentId: agentId });
  return { cfg: loaded.cfg, sessionKey, requesterAgentId: agentId, scope };
}

function sanitizeStatus(status: MemoryProviderStatus) {
  return {
    backend: status.backend,
    provider: status.provider,
    model: status.model,
    files: status.files,
    chunks: status.chunks,
    dirty: status.dirty,
    sources: status.sources,
    sourceCounts: status.sourceCounts,
    cache: status.cache,
    fts: status.fts
      ? { enabled: status.fts.enabled, available: status.fts.available, error: status.fts.error }
      : undefined,
    vector: status.vector
      ? {
          enabled: status.vector.enabled,
          available: status.vector.available,
          dims: status.vector.dims,
        }
      : undefined,
    batch: status.batch,
    fallback: status.fallback
      ? { from: status.fallback.from, reason: status.fallback.reason }
      : undefined,
  };
}

function issueSourceRef(params: {
  requesterAgentId: string;
  agentId: string;
  path: string;
  source?: MemorySource;
  startLine?: number;
  endLine?: number;
}): string {
  const now = Date.now();
  const sourceRef = `memsrc_${randomUUID()}`;
  sourceRefs.set(sourceRef, {
    sourceRef,
    requesterAgentId: params.requesterAgentId,
    agentId: normalizeAgentId(params.agentId),
    path: params.path,
    source: params.source,
    startLine: params.startLine,
    endLine: params.endLine,
    issuedAtMs: now,
    expiresAtMs: now + SOURCE_REF_TTL_MS,
  });
  return sourceRef;
}

function pruneSourceRefs(now = Date.now()) {
  for (const [key, ref] of sourceRefs.entries()) {
    if (ref.expiresAtMs <= now) {
      sourceRefs.delete(key);
    }
  }
}

function decorateSearchHit(
  hit: MemorySearchResult,
  requesterAgentId: string,
  fallbackAgentId: string,
) {
  const agentId = normalizeAgentId(hit.agentId ?? hit.agent_id ?? fallbackAgentId);
  const path = hit.sourcePath ?? hit.source_path ?? hit.path;
  const startLine = hit.start_line ?? hit.startLine;
  const endLine = hit.end_line ?? hit.endLine;
  const sourceRef = issueSourceRef({
    requesterAgentId,
    agentId,
    path,
    source: hit.source,
    startLine,
    endLine,
  });
  return {
    path,
    sourcePath: path,
    source_path: path,
    startLine,
    endLine,
    start_line: startLine,
    end_line: endLine,
    score: hit.score,
    vectorScore: hit.vectorScore,
    textScore: hit.textScore,
    snippet: hit.snippet,
    source: hit.source,
    citation: hit.citation,
    matchType: hit.matchType,
    agentId,
    agent_id: agentId,
    sourceRef,
    openTarget: { kind: "memory-source", sourceRef, line: startLine },
  };
}

async function getManagerOrRespond(params: {
  cfg: OpenClawConfig;
  agentId: string;
  respond: RespondFn;
  purpose?: "default" | "status";
}) {
  const result = await getActiveMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: params.purpose,
  });
  if (!result.manager) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "memory manager unavailable"),
    );
    return null;
  }
  return result.manager;
}

export const memoryHandlers: GatewayRequestHandlers = {
  "memory.status": async ({ params, respond }) => {
    const raw = asRecord(params);
    if (rejectUnexpectedParams(raw, ["sessionKey", "probe"], respond)) return;
    const requester = resolveRequesterContext(raw, respond);
    if (!requester) return;
    try {
      const agents = [];
      for (const agentId of requester.scope.allowedAgentIds) {
        const manager = await getManagerOrRespond({
          cfg: requester.cfg,
          agentId,
          respond,
          purpose: "status",
        });
        if (!manager) return;
        let embedding = manager.getCachedEmbeddingAvailability?.() ?? null;
        if (boolParam(raw, "probe") === true) {
          embedding = await manager.probeEmbeddingAvailability();
        }
        agents.push({ agentId, status: sanitizeStatus(manager.status()), embedding });
      }
      respond(true, {
        requesterAgentId: requester.requesterAgentId,
        scope: requester.scope,
        agents,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `memory.status failed: ${formatErrorMessage(err)}`),
      );
    }
  },

  "memory.sources.list": async ({ params, respond }) => {
    const raw = asRecord(params);
    if (rejectUnexpectedParams(raw, ["sessionKey"], respond)) return;
    const requester = resolveRequesterContext(raw, respond);
    if (!requester) return;
    try {
      const agents = [];
      for (const agentId of requester.scope.allowedAgentIds) {
        const manager = await getManagerOrRespond({
          cfg: requester.cfg,
          agentId,
          respond,
          purpose: "status",
        });
        if (!manager) return;
        const status = manager.status();
        agents.push({
          agentId,
          sources: (status.sources ?? []).map((source) => ({
            source,
            files: status.sourceCounts?.find((entry) => entry.source === source)?.files ?? 0,
            chunks: status.sourceCounts?.find((entry) => entry.source === source)?.chunks ?? 0,
          })),
        });
      }
      respond(true, {
        requesterAgentId: requester.requesterAgentId,
        scope: requester.scope,
        agents,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `memory.sources.list failed: ${formatErrorMessage(err)}`,
        ),
      );
    }
  },

  "memory.search.debug": async ({ params, respond }) => {
    const raw = asRecord(params);
    if (
      rejectUnexpectedParams(
        raw,
        ["sessionKey", "query", "maxResults", "minScore", "corpus"],
        respond,
      )
    )
      return;
    const query = stringParam(raw, "query");
    if (!query) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "memory.search.debug requires query"),
      );
      return;
    }
    const corpus = stringParam(raw, "corpus");
    if (corpus && !["memory", "sessions", "all"].includes(corpus)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid memory.search.debug corpus"),
      );
      return;
    }
    const requester = resolveRequesterContext(raw, respond);
    if (!requester) return;
    try {
      const maxResults = Math.max(
        1,
        Math.min(50, Math.trunc(numberParam(raw, "maxResults") ?? 10)),
      );
      const minScore = numberParam(raw, "minScore");
      const sources =
        corpus === "memory"
          ? ["memory" as MemorySource]
          : corpus === "sessions"
            ? ["sessions" as MemorySource]
            : undefined;
      const startedAtMs = Date.now();
      const results = [];
      const runtimeDebug = [];
      for (const agentId of requester.scope.allowedAgentIds) {
        const manager = await getManagerOrRespond({ cfg: requester.cfg, agentId, respond });
        if (!manager) return;
        const status = manager.status();
        const searchableChunks = (status.sourceCounts ?? [])
          .filter((entry) => !sources || sources.includes(entry.source))
          .reduce((sum, entry) => sum + entry.chunks, 0);
        if (searchableChunks <= 0) {
          runtimeDebug.push({
            agentId,
            backend: status.backend,
            effectiveMode: "skipped-empty-index",
          });
          continue;
        }
        const hits = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: requester.sessionKey,
          ...(sources ? { sources } : {}),
          onDebug: (debug) => runtimeDebug.push({ agentId, ...debug }),
        });
        results.push(
          ...hits.map((hit) => decorateSearchHit(hit, requester.requesterAgentId, agentId)),
        );
      }
      results.sort(
        (left, right) => right.score - left.score || left.path.localeCompare(right.path),
      );
      respond(true, {
        requesterAgentId: requester.requesterAgentId,
        scope: requester.scope,
        query,
        results: results.slice(0, maxResults),
        debug: {
          searchMs: Math.max(0, Date.now() - startedAtMs),
          hits: results.length,
          runtime: runtimeDebug,
        },
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `memory.search.debug failed: ${formatErrorMessage(err)}`,
        ),
      );
    }
  },

  "memory.index.run": async ({ params, respond }) => {
    const raw = asRecord(params);
    if (rejectUnexpectedParams(raw, ["sessionKey", "force", "reason"], respond)) return;
    const requester = resolveRequesterContext(raw, respond);
    if (!requester) return;
    const job: MemoryIndexJob = {
      jobId: `memjob_${randomUUID()}`,
      requesterAgentId: requester.requesterAgentId,
      agentIds: requester.scope.allowedAgentIds,
      status: "running",
      force: boolParam(raw, "force") === true,
      reason: stringParam(raw, "reason") ?? "memory.index.run",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };
    indexJobs.set(job.jobId, job);
    void (async () => {
      try {
        for (const agentId of job.agentIds) {
          const result = await getActiveMemorySearchManager({ cfg: requester.cfg, agentId });
          if (!result.manager?.sync) {
            throw new Error(result.error ?? `memory sync unavailable for ${agentId}`);
          }
          await result.manager.sync({
            force: job.force,
            reason: job.reason,
            progress: (progress) => {
              job.progress = progress;
              job.updatedAtMs = Date.now();
            },
          });
        }
        job.status = "completed";
        job.updatedAtMs = Date.now();
      } catch (err) {
        job.status = "failed";
        job.error = formatErrorMessage(err);
        job.updatedAtMs = Date.now();
      }
    })();
    respond(true, { job });
  },

  "memory.index.jobs": async ({ params, respond }) => {
    const raw = asRecord(params);
    if (rejectUnexpectedParams(raw, ["sessionKey", "limit"], respond)) return;
    const requester = resolveRequesterContext(raw, respond);
    if (!requester) return;
    const limit = Math.max(1, Math.min(100, Math.trunc(numberParam(raw, "limit") ?? 20)));
    const visible = [...indexJobs.values()]
      .filter(
        (job) =>
          job.requesterAgentId === requester.requesterAgentId ||
          job.agentIds.some((agentId) => requester.scope.allowedAgentIds.includes(agentId)),
      )
      .sort((left, right) => right.createdAtMs - left.createdAtMs)
      .slice(0, limit);
    respond(true, { requesterAgentId: requester.requesterAgentId, jobs: visible });
  },

  "memory.source.open": async ({ params, respond }) => {
    const raw = asRecord(params);
    if (rejectUnexpectedParams(raw, ["sessionKey", "sourceRef", "from", "lines"], respond)) return;
    const requester = resolveRequesterContext(raw, respond);
    if (!requester) return;
    pruneSourceRefs();
    const sourceRef = stringParam(raw, "sourceRef");
    const ref = sourceRef ? sourceRefs.get(sourceRef) : undefined;
    if (!sourceRef || !ref) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired memory sourceRef"),
      );
      return;
    }
    if (
      ref.requesterAgentId !== requester.requesterAgentId ||
      !requester.scope.allowedAgentIds.includes(ref.agentId)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "memory sourceRef is outside requester scope"),
      );
      return;
    }
    try {
      const manager = await getManagerOrRespond({
        cfg: requester.cfg,
        agentId: ref.agentId,
        respond,
        purpose: "status",
      });
      if (!manager) return;
      const from = Math.max(1, Math.trunc(numberParam(raw, "from") ?? ref.startLine ?? 1));
      const lines = Math.max(1, Math.min(200, Math.trunc(numberParam(raw, "lines") ?? 80)));
      const read = await manager.readFile({ relPath: ref.path, from, lines });
      respond(true, {
        sourceRef,
        agentId: ref.agentId,
        source: ref.source,
        path: read.path,
        from: read.from,
        lines: read.lines,
        text: read.text,
        truncated: read.truncated,
        nextFrom: read.nextFrom,
        openTarget: { kind: "memory-source", sourceRef, line: from },
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `memory.source.open failed: ${formatErrorMessage(err)}`),
      );
    }
  },
};

export const __testing = {
  clearMemoryRpcState() {
    sourceRefs.clear();
    indexJobs.clear();
  },
  sourceRefCount() {
    return sourceRefs.size;
  },
};
