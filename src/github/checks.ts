import { resolveFetch } from "../infra/fetch.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHECK_RUNS = 20;
const DEFAULT_MAX_STATUSES = 20;
const MAX_PAGE_SIZE = 100;

export type GitHubCheckRunStatus = "queued" | "in_progress" | "completed";

export type GitHubCheckRunConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "success"
  | "timed_out"
  | "startup_failure"
  | null;

export type GitHubCheckRun = {
  id: number;
  name: string;
  status: GitHubCheckRunStatus;
  conclusion: GitHubCheckRunConclusion;
  detailsUrl?: string;
  htmlUrl?: string;
  startedAt?: string;
  completedAt?: string;
  app?: {
    id?: number;
    slug?: string;
    name?: string;
  };
  output?: {
    title?: string;
    summary?: string;
    text?: string;
    annotationsCount?: number;
  };
};

export type GitHubCommitStatusState = "error" | "failure" | "pending" | "success";

export type GitHubCommitStatus = {
  id: number;
  context: string;
  state: GitHubCommitStatusState;
  description?: string;
  targetUrl?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubChecksOverallState = "failure" | "pending" | "success" | "no_data";

export type GitHubChecksSnapshot = {
  repository: string;
  owner: string;
  repo: string;
  ref: string;
  sha?: string;
  overallState: GitHubChecksOverallState;
  combinedStatusState?: "failure" | "pending" | "success";
  summary: {
    failing: number;
    pending: number;
    successful: number;
    neutral: number;
    skipped: number;
    total: number;
  };
  checkRuns: GitHubCheckRun[];
  statuses: GitHubCommitStatus[];
  failing: Array<
    | {
        kind: "check_run";
        name: string;
        status: GitHubCheckRunStatus;
        conclusion: GitHubCheckRunConclusion;
        detailsUrl?: string;
      }
    | {
        kind: "status";
        context: string;
        state: GitHubCommitStatusState;
        description?: string;
        targetUrl?: string;
      }
  >;
  pending: Array<
    | {
        kind: "check_run";
        name: string;
        status: GitHubCheckRunStatus;
        detailsUrl?: string;
      }
    | {
        kind: "status";
        context: string;
        state: GitHubCommitStatusState;
        description?: string;
        targetUrl?: string;
      }
  >;
};

export type LoadGitHubChecksOptions = {
  repo: string;
  ref: string;
  token?: string;
  timeoutMs?: number;
  maxCheckRuns?: number;
  maxStatuses?: number;
  checkName?: string;
  fetchImpl?: typeof fetch;
};

type GitHubCheckRunsResponse = {
  total_count?: number;
  check_runs?: Array<{
    id?: number;
    name?: string;
    status?: GitHubCheckRunStatus;
    conclusion?: GitHubCheckRunConclusion;
    details_url?: string;
    html_url?: string;
    started_at?: string;
    completed_at?: string;
    app?: {
      id?: number;
      slug?: string;
      name?: string;
    };
    output?: {
      title?: string;
      summary?: string;
      text?: string;
      annotations_count?: number;
    };
  }>;
};

type GitHubCombinedStatusResponse = {
  state?: "failure" | "pending" | "success";
  sha?: string;
  statuses?: Array<{
    id?: number;
    context?: string;
    state?: GitHubCommitStatusState;
    description?: string;
    target_url?: string;
    created_at?: string;
    updated_at?: string;
  }>;
};

function isDefined<T>(value: T | null | undefined): value is T {
  return value != null;
}

function normalizeToken(token?: string): string | undefined {
  const trimmed = token?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveGitHubToken(explicitToken?: string): string | undefined {
  const direct = normalizeToken(explicitToken);
  if (direct) {
    return direct;
  }
  return (
    normalizeToken(process.env.GH_TOKEN) ??
    normalizeToken(process.env.GITHUB_TOKEN) ??
    normalizeToken(process.env.COPILOT_GITHUB_TOKEN)
  );
}

export function parseGitHubRepo(input: string): {
  owner: string;
  repo: string;
  repository: string;
} {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid GitHub repository "${input}". Expected "owner/repo".`);
  }
  return {
    owner: parts[0],
    repo: parts[1],
    repository: `${parts[0]}/${parts[1]}`,
  };
}

function clampPageSize(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(value)));
}

function buildGitHubHeaders(token?: string): HeadersInit {
  const normalizedToken = resolveGitHubToken(token);
  return {
    Accept: "application/vnd.github+json",
    ...(normalizedToken ? { Authorization: `Bearer ${normalizedToken}` } : {}),
    "User-Agent": "OpenClaw GitHub Checks Tool",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

async function fetchGitHubJson<T>(params: {
  path: string;
  token?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const fetchFn = resolveFetch(params.fetchImpl);
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }
  const response = await fetchFn(`${GITHUB_API_BASE_URL}${params.path}`, {
    method: "GET",
    headers: buildGitHubHeaders(params.token),
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const suffix = body.trim() ? `: ${body.trim()}` : "";
    throw new Error(`GitHub API ${response.status} ${response.statusText}${suffix}`);
  }
  return (await response.json()) as T;
}

function normalizeCheckRun(
  input: NonNullable<GitHubCheckRunsResponse["check_runs"]>[number],
): GitHubCheckRun | null {
  if (typeof input.id !== "number" || !Number.isFinite(input.id)) {
    return null;
  }
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : undefined;
  const status = input.status;
  if (!name || (status !== "queued" && status !== "in_progress" && status !== "completed")) {
    return null;
  }
  return {
    id: input.id,
    name,
    status,
    conclusion: input.conclusion ?? null,
    detailsUrl: typeof input.details_url === "string" ? input.details_url : undefined,
    htmlUrl: typeof input.html_url === "string" ? input.html_url : undefined,
    startedAt: typeof input.started_at === "string" ? input.started_at : undefined,
    completedAt: typeof input.completed_at === "string" ? input.completed_at : undefined,
    app: input.app
      ? {
          id: input.app.id,
          slug: typeof input.app.slug === "string" ? input.app.slug : undefined,
          name: typeof input.app.name === "string" ? input.app.name : undefined,
        }
      : undefined,
    output: input.output
      ? {
          title: typeof input.output.title === "string" ? input.output.title : undefined,
          summary: typeof input.output.summary === "string" ? input.output.summary : undefined,
          text: typeof input.output.text === "string" ? input.output.text : undefined,
          annotationsCount:
            typeof input.output.annotations_count === "number" &&
            Number.isFinite(input.output.annotations_count)
              ? input.output.annotations_count
              : undefined,
        }
      : undefined,
  };
}

function normalizeCommitStatus(
  input: NonNullable<GitHubCombinedStatusResponse["statuses"]>[number],
): GitHubCommitStatus | null {
  if (typeof input.id !== "number" || !Number.isFinite(input.id)) {
    return null;
  }
  const context =
    typeof input.context === "string" && input.context.trim() ? input.context.trim() : undefined;
  const state = input.state;
  if (
    !context ||
    (state !== "error" && state !== "failure" && state !== "pending" && state !== "success")
  ) {
    return null;
  }
  return {
    id: input.id,
    context,
    state,
    description: typeof input.description === "string" ? input.description : undefined,
    targetUrl: typeof input.target_url === "string" ? input.target_url : undefined,
    createdAt: typeof input.created_at === "string" ? input.created_at : undefined,
    updatedAt: typeof input.updated_at === "string" ? input.updated_at : undefined,
  };
}

function isFailingCheckRun(run: GitHubCheckRun): boolean {
  return (
    run.status === "completed" &&
    ["action_required", "cancelled", "failure", "stale", "timed_out", "startup_failure"].includes(
      run.conclusion ?? "",
    )
  );
}

function isPendingCheckRun(run: GitHubCheckRun): boolean {
  return run.status === "queued" || run.status === "in_progress";
}

function isSuccessfulCheckRun(run: GitHubCheckRun): boolean {
  return run.status === "completed" && run.conclusion === "success";
}

function isNeutralCheckRun(run: GitHubCheckRun): boolean {
  return run.status === "completed" && run.conclusion === "neutral";
}

function isSkippedCheckRun(run: GitHubCheckRun): boolean {
  return run.status === "completed" && run.conclusion === "skipped";
}

function resolveOverallState(params: {
  checkRuns: GitHubCheckRun[];
  statuses: GitHubCommitStatus[];
  combinedStatusState?: "failure" | "pending" | "success";
}): GitHubChecksOverallState {
  if (
    params.combinedStatusState === "failure" ||
    params.checkRuns.some(isFailingCheckRun) ||
    params.statuses.some((status) => status.state === "error" || status.state === "failure")
  ) {
    return "failure";
  }
  if (
    params.combinedStatusState === "pending" ||
    params.checkRuns.some(isPendingCheckRun) ||
    params.statuses.some((status) => status.state === "pending")
  ) {
    return "pending";
  }
  if (params.checkRuns.length === 0 && params.statuses.length === 0) {
    return "no_data";
  }
  return "success";
}

export async function loadGitHubChecks(
  options: LoadGitHubChecksOptions,
): Promise<GitHubChecksSnapshot> {
  const parsedRepo = parseGitHubRepo(options.repo);
  const ref = options.ref.trim();
  if (!ref) {
    throw new Error("GitHub ref is required.");
  }
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
  const maxCheckRuns = clampPageSize(options.maxCheckRuns, DEFAULT_MAX_CHECK_RUNS);
  const maxStatuses = clampPageSize(options.maxStatuses, DEFAULT_MAX_STATUSES);

  const checkRunsPath = new URL(
    `/repos/${encodeURIComponent(parsedRepo.owner)}/${encodeURIComponent(parsedRepo.repo)}/commits/${encodeURIComponent(ref)}/check-runs`,
    GITHUB_API_BASE_URL,
  );
  checkRunsPath.searchParams.set("filter", "latest");
  checkRunsPath.searchParams.set("per_page", String(maxCheckRuns));
  if (options.checkName?.trim()) {
    checkRunsPath.searchParams.set("check_name", options.checkName.trim());
  }

  const statusPath = new URL(
    `/repos/${encodeURIComponent(parsedRepo.owner)}/${encodeURIComponent(parsedRepo.repo)}/commits/${encodeURIComponent(ref)}/status`,
    GITHUB_API_BASE_URL,
  );
  statusPath.searchParams.set("per_page", String(maxStatuses));

  const [checkRunsResponse, combinedStatusResponse] = await Promise.all([
    fetchGitHubJson<GitHubCheckRunsResponse>({
      path: `${checkRunsPath.pathname}${checkRunsPath.search}`,
      token: options.token,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    }),
    fetchGitHubJson<GitHubCombinedStatusResponse>({
      path: `${statusPath.pathname}${statusPath.search}`,
      token: options.token,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    }),
  ]);

  const checkRuns = (checkRunsResponse.check_runs ?? []).map(normalizeCheckRun).filter(isDefined);
  const statuses = (combinedStatusResponse.statuses ?? [])
    .map(normalizeCommitStatus)
    .filter(isDefined);

  const failing = [
    ...checkRuns.filter(isFailingCheckRun).map((run) => ({
      kind: "check_run" as const,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      detailsUrl: run.detailsUrl ?? run.htmlUrl,
    })),
    ...statuses
      .filter((status) => status.state === "error" || status.state === "failure")
      .map((status) => ({
        kind: "status" as const,
        context: status.context,
        state: status.state,
        description: status.description,
        targetUrl: status.targetUrl,
      })),
  ];

  const pending = [
    ...checkRuns.filter(isPendingCheckRun).map((run) => ({
      kind: "check_run" as const,
      name: run.name,
      status: run.status,
      detailsUrl: run.detailsUrl ?? run.htmlUrl,
    })),
    ...statuses
      .filter((status) => status.state === "pending")
      .map((status) => ({
        kind: "status" as const,
        context: status.context,
        state: status.state,
        description: status.description,
        targetUrl: status.targetUrl,
      })),
  ];

  return {
    repository: parsedRepo.repository,
    owner: parsedRepo.owner,
    repo: parsedRepo.repo,
    ref,
    sha: typeof combinedStatusResponse.sha === "string" ? combinedStatusResponse.sha : undefined,
    overallState: resolveOverallState({
      checkRuns,
      statuses,
      combinedStatusState: combinedStatusResponse.state,
    }),
    combinedStatusState: combinedStatusResponse.state,
    summary: {
      failing: failing.length,
      pending: pending.length,
      successful:
        checkRuns.filter(isSuccessfulCheckRun).length +
        statuses.filter((status) => status.state === "success").length,
      neutral: checkRuns.filter(isNeutralCheckRun).length,
      skipped: checkRuns.filter(isSkippedCheckRun).length,
      total: checkRuns.length + statuses.length,
    },
    checkRuns,
    statuses,
    failing,
    pending,
  };
}
