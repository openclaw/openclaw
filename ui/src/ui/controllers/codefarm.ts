// Control UI controller implements the first-class Code Farm surface.
import type { GatewayBrowserClient } from "../gateway.ts";

const CODEFARM_DEFAULT_LINES = 200;
const CODEFARM_MAX_LINES = 1000;

export type CodefarmRepoSummary = {
  repo: string;
  name: string;
  totalJobs: number;
  activeJobs: number;
  reviewJobs: number;
  blockedJobs: number;
  latestUpdatedAt?: string;
  statuses: Record<string, number>;
};

export type CodefarmJobSummary = {
  id: string;
  status: string;
  runtime?: string;
  observedOrManaged?: string;
  cwd?: string;
  worktree?: string;
  taskIntent?: string;
  branch?: string;
  nextAction?: string;
};

export type CodefarmObservation = {
  jobId: string;
  repo?: string;
  worktree?: string;
  status?: string;
  runtime?: string;
  branch?: string;
  updatedAt?: string | number;
  tmux?: {
    available?: boolean;
    enabled?: boolean;
    session?: string;
    window?: string;
    pane?: string;
    attachCommand?: string;
    note?: string | null;
  };
  terminal: {
    source: string;
    truncated: boolean;
    lines: string[];
  };
  handoff?: {
    taskFile?: string;
    summary?: string;
  };
  changes?: {
    touchedFiles: string[];
    hasUncommittedChanges: boolean;
    diffHash?: string;
  };
  proof?: {
    proofFile?: string;
    verdict?: string;
  };
};

export type CodefarmState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  repos: CodefarmRepoSummary[];
  selectedRepo: string | null;
  repoInput: string;
  jobsLoading: boolean;
  jobsError: string | null;
  jobs: CodefarmJobSummary[];
  selectedJobId: string | null;
  observing: boolean;
  observeError: string | null;
  observation: CodefarmObservation | null;
  updatedAt: number | null;
};

const states = new WeakMap<object, CodefarmState>();

function createDefaultCodefarmState(): CodefarmState {
  return {
    loaded: false,
    loading: false,
    error: null,
    repos: [],
    selectedRepo: null,
    repoInput: "",
    jobsLoading: false,
    jobsError: null,
    jobs: [],
    selectedJobId: null,
    observing: false,
    observeError: null,
    observation: null,
    updatedAt: null,
  };
}

export function getCodefarmState(host: object): CodefarmState {
  let state = states.get(host);
  if (!state) {
    state = createDefaultCodefarmState();
    states.set(host, state);
  }
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeStatusCounts(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, count]) =>
      typeof count === "number" && Number.isFinite(count) ? [[key, count]] : [],
    ),
  );
}

function normalizeCodefarmRepo(value: unknown): CodefarmRepoSummary | null {
  if (!isRecord(value) || typeof value.repo !== "string" || !value.repo.trim()) {
    return null;
  }
  const repo = value.repo.trim();
  return {
    repo,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : repo,
    totalJobs: normalizeNumber(value.totalJobs),
    activeJobs: normalizeNumber(value.activeJobs),
    reviewJobs: normalizeNumber(value.reviewJobs),
    blockedJobs: normalizeNumber(value.blockedJobs),
    ...(typeof value.latestUpdatedAt === "string"
      ? { latestUpdatedAt: value.latestUpdatedAt }
      : {}),
    statuses: normalizeStatusCounts(value.statuses),
  };
}

function normalizeReposPayload(payload: unknown): CodefarmRepoSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.repos)) {
    return [];
  }
  return payload.repos
    .map(normalizeCodefarmRepo)
    .filter((repo): repo is CodefarmRepoSummary => repo !== null);
}

function normalizeCodefarmJob(value: unknown): CodefarmJobSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    return null;
  }
  return {
    id: value.id.trim(),
    status:
      typeof value.status === "string" && value.status.trim() ? value.status.trim() : "unknown",
    ...(typeof value.runtime === "string" ? { runtime: value.runtime } : {}),
    ...(typeof value.observedOrManaged === "string"
      ? { observedOrManaged: value.observedOrManaged }
      : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.worktree === "string" ? { worktree: value.worktree } : {}),
    ...(typeof value.taskIntent === "string" ? { taskIntent: value.taskIntent } : {}),
    ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
    ...(typeof value.nextAction === "string" ? { nextAction: value.nextAction } : {}),
  };
}

function normalizeJobsPayload(payload: unknown): CodefarmJobSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    return [];
  }
  return payload.jobs
    .map(normalizeCodefarmJob)
    .filter((job): job is CodefarmJobSummary => job !== null);
}

function normalizeTmux(value: unknown): CodefarmObservation["tmux"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    ...(typeof value.available === "boolean" ? { available: value.available } : {}),
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(typeof value.session === "string" ? { session: value.session } : {}),
    ...(typeof value.window === "string" ? { window: value.window } : {}),
    ...(typeof value.pane === "string" ? { pane: value.pane } : {}),
    ...(typeof value.attachCommand === "string" ? { attachCommand: value.attachCommand } : {}),
    ...(typeof value.note === "string" || value.note === null ? { note: value.note } : {}),
  };
}

function normalizeTerminal(value: unknown): CodefarmObservation["terminal"] {
  if (!isRecord(value)) {
    return { source: "log", truncated: false, lines: [] };
  }
  return {
    source: typeof value.source === "string" && value.source.trim() ? value.source : "log",
    truncated: Boolean(value.truncated),
    lines: normalizeStringArray(value.lines),
  };
}

function normalizeObservation(
  payload: unknown,
  fallback: { repo: string; jobId: string },
): CodefarmObservation {
  const record = isRecord(payload) ? payload : {};
  const handoff = isRecord(record.handoff) ? record.handoff : null;
  const changes = isRecord(record.changes) ? record.changes : null;
  const proof = isRecord(record.proof) ? record.proof : null;
  return {
    jobId:
      typeof record.jobId === "string" && record.jobId.trim()
        ? record.jobId.trim()
        : fallback.jobId,
    ...(typeof record.repo === "string" ? { repo: record.repo } : { repo: fallback.repo }),
    ...(typeof record.worktree === "string" ? { worktree: record.worktree } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.runtime === "string" ? { runtime: record.runtime } : {}),
    ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
    ...(typeof record.updatedAt === "string" || typeof record.updatedAt === "number"
      ? { updatedAt: record.updatedAt }
      : {}),
    ...(normalizeTmux(record.tmux) ? { tmux: normalizeTmux(record.tmux) } : {}),
    terminal: normalizeTerminal(record.terminal),
    ...(handoff
      ? {
          handoff: {
            ...(typeof handoff.taskFile === "string" ? { taskFile: handoff.taskFile } : {}),
            ...(typeof handoff.summary === "string" ? { summary: handoff.summary } : {}),
          },
        }
      : {}),
    ...(changes
      ? {
          changes: {
            touchedFiles: normalizeStringArray(changes.touchedFiles),
            hasUncommittedChanges: Boolean(changes.hasUncommittedChanges),
            ...(typeof changes.diffHash === "string" ? { diffHash: changes.diffHash } : {}),
          },
        }
      : {}),
    ...(proof
      ? {
          proof: {
            ...(typeof proof.proofFile === "string" ? { proofFile: proof.proofFile } : {}),
            ...(typeof proof.verdict === "string" ? { verdict: proof.verdict } : {}),
          },
        }
      : {}),
  };
}

function normalizeLineCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CODEFARM_DEFAULT_LINES;
  }
  return Math.max(0, Math.min(CODEFARM_MAX_LINES, Math.trunc(value)));
}

export async function loadCodefarmRepos(params: {
  host: object;
  client: GatewayBrowserClient | null;
  roots?: string[];
  requestUpdate?: () => void;
}) {
  const state = getCodefarmState(params.host);
  state.loading = true;
  state.error = null;
  params.requestUpdate?.();
  try {
    if (!params.client) {
      throw new Error("Gateway client is not connected.");
    }
    const payload = await params.client.request("codefarm.repos", {
      ...(params.roots ? { roots: params.roots } : {}),
    });
    const repos = normalizeReposPayload(payload);
    const selectedRepo =
      state.selectedRepo && repos.some((repo) => repo.repo === state.selectedRepo)
        ? state.selectedRepo
        : (repos[0]?.repo ?? null);
    state.repos = repos;
    state.selectedRepo = selectedRepo;
    state.repoInput = selectedRepo ?? state.repoInput;
    state.loaded = true;
    state.loading = false;
    state.error = null;
    state.updatedAt = Date.now();
  } catch (error) {
    state.loaded = true;
    state.loading = false;
    state.error = formatError(error);
    state.updatedAt = Date.now();
  } finally {
    params.requestUpdate?.();
  }
}

export async function loadCodefarmJobs(params: {
  host: object;
  client: GatewayBrowserClient | null;
  repo?: string;
  requestUpdate?: () => void;
}) {
  const state = getCodefarmState(params.host);
  const repo = (params.repo ?? state.selectedRepo ?? state.repoInput).trim();
  state.selectedRepo = repo || null;
  state.repoInput = repo;
  state.jobsLoading = true;
  state.jobsError = null;
  state.observation = null;
  params.requestUpdate?.();
  try {
    if (!repo) {
      throw new Error("Repo path is required.");
    }
    if (!params.client) {
      throw new Error("Gateway client is not connected.");
    }
    const payload = await params.client.request("codefarm.list", { repo });
    const jobs = normalizeJobsPayload(payload);
    state.jobs = jobs;
    state.selectedJobId =
      state.selectedJobId && jobs.some((job) => job.id === state.selectedJobId)
        ? state.selectedJobId
        : (jobs[0]?.id ?? null);
    state.jobsLoading = false;
    state.jobsError = null;
    state.updatedAt = Date.now();
  } catch (error) {
    state.jobsLoading = false;
    state.jobsError = formatError(error);
    state.updatedAt = Date.now();
  } finally {
    params.requestUpdate?.();
  }
}

export async function selectCodefarmRepo(params: {
  host: object;
  client: GatewayBrowserClient | null;
  repo: string;
  requestUpdate?: () => void;
}) {
  const state = getCodefarmState(params.host);
  state.selectedRepo = params.repo;
  state.repoInput = params.repo;
  state.selectedJobId = null;
  state.jobs = [];
  state.observation = null;
  params.requestUpdate?.();
  await loadCodefarmJobs(params);
}

export async function observeCodefarmJob(params: {
  host: object;
  client: GatewayBrowserClient | null;
  repo: string;
  jobId: string;
  lines?: number;
  requestUpdate?: () => void;
}) {
  const state = getCodefarmState(params.host);
  state.selectedRepo = params.repo;
  state.repoInput = params.repo;
  state.selectedJobId = params.jobId;
  state.observing = true;
  state.observeError = null;
  params.requestUpdate?.();
  try {
    if (!params.client) {
      throw new Error("Gateway client is not connected.");
    }
    const lines = normalizeLineCount(params.lines);
    const payload = await params.client.request("codefarm.observe", {
      repo: params.repo,
      jobId: params.jobId,
      lines,
    });
    state.observation = normalizeObservation(payload, {
      repo: params.repo,
      jobId: params.jobId,
    });
    state.observing = false;
    state.observeError = null;
    state.updatedAt = Date.now();
  } catch (error) {
    state.observing = false;
    state.observeError = formatError(error);
    state.updatedAt = Date.now();
  } finally {
    params.requestUpdate?.();
  }
}
