import type { GatewayBrowserClient } from "../gateway.ts";

type RecordLike = Record<string, unknown>;

export type MemoryScope = {
  requesterAgentId?: string;
  allowedAgentIds?: string[];
  crossAgent?: boolean;
};

export type MemoryAgentStatus = {
  agentId: string;
  status?: RecordLike;
  embedding?: unknown;
};

export type MemoryStatusResult = {
  requesterAgentId?: string;
  scope?: MemoryScope;
  agents?: MemoryAgentStatus[];
};

export type MemorySourceSummary = {
  source?: string;
  files?: number;
  chunks?: number;
};

export type MemorySourcesAgent = {
  agentId: string;
  sources?: MemorySourceSummary[];
};

export type MemorySourcesResult = {
  requesterAgentId?: string;
  scope?: MemoryScope;
  agents?: MemorySourcesAgent[];
};

export type MemorySearchResult = {
  path?: string;
  sourcePath?: string;
  source_path?: string;
  startLine?: number;
  endLine?: number;
  start_line?: number;
  end_line?: number;
  score?: number;
  vectorScore?: number;
  textScore?: number;
  snippet?: string;
  source?: string;
  citation?: unknown;
  matchType?: string;
  agentId?: string;
  agent_id?: string;
  sourceRef?: string;
  openTarget?: unknown;
};

export type MemorySearchDebugResult = {
  requesterAgentId?: string;
  scope?: MemoryScope;
  query?: string;
  results?: MemorySearchResult[];
  debug?: unknown;
};

export type MemoryIndexJob = {
  jobId?: string;
  id?: string;
  requesterAgentId?: string;
  agentIds?: string[];
  status?: "running" | "completed" | "failed" | string;
  force?: boolean;
  reason?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  error?: string;
  progress?: { completed?: number; total?: number; label?: string };
};

export type MemoryIndexJobsResult = {
  requesterAgentId?: string;
  jobs?: MemoryIndexJob[];
};

export type MemorySourceOpenResult = {
  sourceRef?: string;
  agentId?: string;
  source?: string;
  path?: string;
  from?: number;
  lines?: number;
  text?: string;
  truncated?: boolean;
  nextFrom?: number;
  openTarget?: unknown;
};

export type MemorySearchCorpus = "memory" | "sessions" | "all";

export type MemoryState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  memoryStatusLoading: boolean;
  memoryStatusError: string | null;
  memoryStatus: MemoryStatusResult | null;
  memorySourcesLoading: boolean;
  memorySourcesError: string | null;
  memorySources: MemorySourcesResult | null;
  memorySearchQuery: string;
  memorySearchCorpus: MemorySearchCorpus;
  memorySearchMaxResults: number;
  memorySearchMinScore: string;
  memorySearchLoading: boolean;
  memorySearchError: string | null;
  memorySearchResult: MemorySearchDebugResult | null;
  memoryIndexLoading: boolean;
  memoryIndexError: string | null;
  memoryIndexMessage: string | null;
  memoryJobsLoading: boolean;
  memoryJobsError: string | null;
  memoryJobs: MemoryIndexJob[];
  memorySourceOpenLoading: boolean;
  memorySourceOpenError: string | null;
  memorySourceOpen: MemorySourceOpenResult | null;
};

function formatControllerError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sessionParams(state: MemoryState) {
  return { sessionKey: state.sessionKey };
}

export async function loadMemoryStatus(state: MemoryState, opts: { probe?: boolean } = {}) {
  if (!state.client || !state.connected || state.memoryStatusLoading) {
    return;
  }
  state.memoryStatusLoading = true;
  state.memoryStatusError = null;
  try {
    const res = await state.client.request("memory.status", {
      ...sessionParams(state),
      ...(opts.probe ? { probe: true } : {}),
    });
    state.memoryStatus = res as MemoryStatusResult;
  } catch (err) {
    state.memoryStatusError = formatControllerError(err);
  } finally {
    state.memoryStatusLoading = false;
  }
}

export async function loadMemorySources(state: MemoryState) {
  if (!state.client || !state.connected || state.memorySourcesLoading) {
    return;
  }
  state.memorySourcesLoading = true;
  state.memorySourcesError = null;
  try {
    const res = await state.client.request("memory.sources.list", sessionParams(state));
    state.memorySources = res as MemorySourcesResult;
  } catch (err) {
    state.memorySourcesError = formatControllerError(err);
  } finally {
    state.memorySourcesLoading = false;
  }
}

export async function runMemorySearchDebug(state: MemoryState) {
  if (!state.client || !state.connected || state.memorySearchLoading) {
    return;
  }
  const query = state.memorySearchQuery.trim();
  if (!query) {
    state.memorySearchError = "Search query is required.";
    return;
  }
  state.memorySearchLoading = true;
  state.memorySearchError = null;
  try {
    const minScoreRaw = state.memorySearchMinScore.trim();
    const minScore = minScoreRaw ? Number(minScoreRaw) : undefined;
    const res = await state.client.request("memory.search.debug", {
      ...sessionParams(state),
      query,
      maxResults: Math.max(1, Math.min(50, Math.trunc(state.memorySearchMaxResults || 10))),
      ...(Number.isFinite(minScore) ? { minScore } : {}),
      ...(state.memorySearchCorpus === "all" ? {} : { corpus: state.memorySearchCorpus }),
    });
    state.memorySearchResult = res as MemorySearchDebugResult;
  } catch (err) {
    state.memorySearchError = formatControllerError(err);
  } finally {
    state.memorySearchLoading = false;
  }
}

export async function runMemoryIndex(state: MemoryState, opts: { force?: boolean } = {}) {
  if (!state.client || !state.connected || state.memoryIndexLoading) {
    return;
  }
  state.memoryIndexLoading = true;
  state.memoryIndexError = null;
  state.memoryIndexMessage = null;
  try {
    const res = await state.client.request("memory.index.run", {
      ...sessionParams(state),
      ...(opts.force ? { force: true } : {}),
      reason: opts.force ? "control-ui memory force index" : "control-ui memory index",
    });
    const payload = res as { job?: MemoryIndexJob };
    state.memoryIndexMessage = payload.job?.jobId
      ? `Index job ${payload.job.jobId} started.`
      : "Index job started.";
    await loadMemoryIndexJobs(state);
    await loadMemoryStatus(state);
    await loadMemorySources(state);
  } catch (err) {
    state.memoryIndexError = formatControllerError(err);
  } finally {
    state.memoryIndexLoading = false;
  }
}

export async function loadMemoryIndexJobs(state: MemoryState) {
  if (!state.client || !state.connected || state.memoryJobsLoading) {
    return;
  }
  state.memoryJobsLoading = true;
  state.memoryJobsError = null;
  try {
    const res = await state.client.request("memory.index.jobs", {
      ...sessionParams(state),
      limit: 20,
    });
    const payload = res as MemoryIndexJobsResult;
    state.memoryJobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  } catch (err) {
    state.memoryJobsError = formatControllerError(err);
  } finally {
    state.memoryJobsLoading = false;
  }
}

export async function openMemorySource(
  state: MemoryState,
  sourceRef: string,
  opts: { from?: number; lines?: number } = {},
) {
  if (!state.client || !state.connected || state.memorySourceOpenLoading) {
    return;
  }
  const ref = sourceRef.trim();
  if (!ref) {
    return;
  }
  state.memorySourceOpenLoading = true;
  state.memorySourceOpenError = null;
  try {
    const res = await state.client.request("memory.source.open", {
      ...sessionParams(state),
      sourceRef: ref,
      ...(typeof opts.from === "number" ? { from: opts.from } : {}),
      ...(typeof opts.lines === "number" ? { lines: opts.lines } : {}),
    });
    state.memorySourceOpen = res as MemorySourceOpenResult;
  } catch (err) {
    state.memorySourceOpenError = formatControllerError(err);
  } finally {
    state.memorySourceOpenLoading = false;
  }
}
