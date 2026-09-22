import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestCheck,
  ControlUiSessionPullRequestCheckDetails,
  ControlUiSessionPullRequestCheckStep,
} from "./control-ui-contract.js";
import {
  ControlUiGitHubError,
  fetchGitHubJson,
  GITHUB_API_ORIGIN,
} from "./control-ui-github-api.js";

const FAILING_CHECK_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
// Check and Actions metadata repeat verbose output/application/repository objects.
const PAGE_BYTES = 1024 * 1024;
const MAX_ACTIONS_SUITES = 20;
const MAX_STEPS = 200;

export type SessionPullRequestCheckTarget = Pick<
  ControlUiSessionPullRequestCheckDetails,
  "owner" | "repo" | "number" | "headSha"
>;
export type GitHubCheckRequest = (url: string, maxBytes?: number) => Promise<unknown>;

function sessionPullRequestCheckState(
  status: unknown,
  conclusion: unknown,
): ControlUiSessionPullRequestCheck["state"] {
  if (typeof conclusion === "string" && FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
    return "failed";
  }
  if (status !== "completed" || conclusion === "stale") {
    return "running";
  }
  return conclusion === "skipped" ? "skipped" : "passed";
}

export function sessionPullRequestRepositoryApiUrl(target: {
  owner: string;
  repo: string;
}): string {
  return `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

function incomplete(): ControlUiGitHubError {
  return new ControlUiGitHubError(
    502,
    "GitHub CI details were incomplete or changed while loading",
  );
}

/** One bounded pagination owner serves both the compact rollup and on-demand detail. */
async function fetchSessionPullRequestCheckRuns(
  target: { owner: string; repo: string; headSha: string },
  request: GitHubCheckRequest,
): Promise<Record<string, unknown>[]> {
  return fetchPages(
    `${sessionPullRequestRepositoryApiUrl(target)}/commits/${target.headSha}/check-runs?filter=latest`,
    "check_runs",
    request,
  );
}

async function fetchPages(
  url: string,
  field: string,
  request: GitHubCheckRequest,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let expected: number | undefined;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const value = await request(`${url}&per_page=${PAGE_SIZE}&page=${page}`, PAGE_BYTES);
    if (!isRecord(value)) {
      throw incomplete();
    }
    const items = value[field];
    const total = value.total_count;
    if (
      !Array.isArray(items) ||
      items.length > PAGE_SIZE ||
      typeof total !== "number" ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      total > PAGE_SIZE * MAX_PAGES ||
      (expected !== undefined && expected !== total)
    ) {
      throw incomplete();
    }
    expected = total;
    for (const item of items) {
      if (!isRecord(item)) {
        throw incomplete();
      }
      rows.push(item);
    }
    if (rows.length === total) {
      return rows;
    }
    if (rows.length > total || items.length < PAGE_SIZE) {
      throw incomplete();
    }
  }
  throw incomplete();
}

export async function fetchSessionPullRequestCheckRollup(
  item: { owner: string; repo: string; headSha?: string },
  fetchImpl: typeof fetch,
  token?: string,
): Promise<ControlUiSessionPullRequest["checks"]> {
  if (!item.headSha || !/^[0-9a-f]{40}$/i.test(item.headSha)) {
    return undefined;
  }
  const runs = await fetchSessionPullRequestCheckRuns(
    { ...item, headSha: item.headSha },
    (url, maxBytes) => fetchGitHubJson(url, fetchImpl, token, maxBytes),
  );
  if (runs.length === 0) {
    return undefined;
  }
  const counts = { passed: 0, failed: 0, skipped: 0, running: 0 };
  for (const run of runs) {
    counts[sessionPullRequestCheckState(run.status, run.conclusion)] += 1;
  }
  return {
    state: counts.failed > 0 ? "failing" : counts.running > 0 ? "pending" : "passing",
    ...counts,
  };
}

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw incomplete();
  }
  return value;
}

function text(value: unknown, max = 512): string {
  const result = readNonBlankString(value);
  if (!result || result.length > max) {
    throw incomplete();
  }
  return result;
}

function timing(value: Record<string, unknown>): { startedAt?: string; completedAt?: string } {
  const timestamp = (raw: unknown) => {
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const date = text(raw, 40);
    if (!Number.isFinite(Date.parse(date))) {
      throw incomplete();
    }
    return date;
  };
  return { startedAt: timestamp(value.started_at), completedAt: timestamp(value.completed_at) };
}

function readConclusion(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value, 64);
}

function safeCheckLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

type ParsedCheck = { check: ControlUiSessionPullRequestCheck; suiteId?: number };

function parseChecks(
  rows: Record<string, unknown>[],
  target: SessionPullRequestCheckTarget,
): ParsedCheck[] {
  const ids = new Set<number>();
  return rows.map((row) => {
    const id = positiveId(row.id);
    if (ids.has(id) || row.head_sha !== target.headSha) {
      throw incomplete();
    }
    ids.add(id);
    const source = isRecord(row.app) && row.app.slug === "github-actions" ? "actions" : "check";
    const status = text(row.status, 64);
    const result = readConclusion(row.conclusion);
    return {
      check: {
        id,
        name: text(row.name),
        status,
        conclusion: result,
        state: sessionPullRequestCheckState(status, result),
        source,
        detailsUrl: safeCheckLink(row.details_url ?? row.html_url),
        ...timing(row),
      },
      ...(source === "actions" && isRecord(row.check_suite)
        ? { suiteId: positiveId(row.check_suite.id) }
        : {}),
    };
  });
}

function parseSteps(value: unknown): ControlUiSessionPullRequestCheckStep[] {
  if (!Array.isArray(value) || value.length > MAX_STEPS) {
    throw incomplete();
  }
  const numbers = new Set<number>();
  return value
    .map((step) => {
      if (!isRecord(step)) {
        throw incomplete();
      }
      const number = positiveId(step.number);
      if (numbers.has(number)) {
        throw incomplete();
      }
      numbers.add(number);
      return {
        number,
        name: text(step.name),
        status: text(step.status, 64),
        conclusion: readConclusion(step.conclusion),
        ...timing(step),
      };
    })
    .toSorted((left, right) => left.number - right.number);
}

async function loadSuiteJobs(
  target: SessionPullRequestCheckTarget,
  suiteId: number,
  checks: ParsedCheck[],
  request: GitHubCheckRequest,
): Promise<Map<number, ControlUiSessionPullRequestCheck>> {
  const base = sessionPullRequestRepositoryApiUrl(target);
  const runs = await fetchPages(
    `${base}/actions/runs?head_sha=${target.headSha}&check_suite_id=${suiteId}`,
    "workflow_runs",
    request,
  );
  // A suite belongs to a single workflow run. Never guess using a check name or numeric ID.
  if (
    runs.length !== 1 ||
    runs[0]?.check_suite_id !== suiteId ||
    runs[0]?.head_sha !== target.headSha
  ) {
    throw incomplete();
  }
  const runId = positiveId(runs[0].id);
  const attempt = runs[0].run_attempt === undefined ? undefined : positiveId(runs[0].run_attempt);
  // "all" includes successful jobs retained from earlier attempts of a failed-job-only rerun.
  // Only jobs whose documented check_run_url matches the current check inventory can join.
  const jobs = await fetchPages(`${base}/actions/runs/${runId}/jobs?filter=all`, "jobs", request);
  const wanted = new Map(
    checks
      .filter((row) => row.suiteId === suiteId)
      .map(({ check }) => [`${base}/check-runs/${check.id}`.toLowerCase(), check]),
  );
  const result = new Map<number, ControlUiSessionPullRequestCheck>();
  for (const job of jobs) {
    if (
      job.run_id !== runId ||
      job.head_sha !== target.headSha ||
      (job.run_attempt !== undefined &&
        attempt !== undefined &&
        positiveId(job.run_attempt) > attempt)
    ) {
      throw incomplete();
    }
    const check =
      typeof job.check_run_url === "string"
        ? wanted.get(job.check_run_url.toLowerCase())
        : undefined;
    if (!check) {
      continue;
    }
    if (result.has(check.id)) {
      throw incomplete();
    }
    const jobId = positiveId(job.id);
    const status = text(job.status, 64);
    const verdict = readConclusion(job.conclusion);
    result.set(check.id, {
      ...check,
      status,
      conclusion: verdict,
      state: sessionPullRequestCheckState(status, verdict),
      ...timing(job),
      detailsUrl: `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/actions/runs/${runId}/job/${jobId}`,
      steps: parseSteps(job.steps ?? []),
    });
  }
  if ([...wanted.values()].some((check) => check.state !== "skipped" && !result.has(check.id))) {
    throw incomplete();
  }
  return result;
}

/** Checks remain useful when Actions permissions, history, or the bounded detail budget fail. */
export async function fetchSessionPullRequestCheckDetails(
  target: SessionPullRequestCheckTarget,
  request: GitHubCheckRequest,
): Promise<{ checks: ControlUiSessionPullRequestCheck[]; error?: unknown }> {
  const rows = parseChecks(await fetchSessionPullRequestCheckRuns(target, request), target);
  const priority = { failed: 0, running: 1, passed: 2, skipped: 3 };
  const orderedRows = rows.toSorted(
    (a, b) =>
      priority[a.check.state] - priority[b.check.state] ||
      a.check.name.localeCompare(b.check.name) ||
      a.check.id - b.check.id,
  );
  const suites = [
    ...new Set(
      orderedRows
        .filter(({ check }) => check.source === "actions" && check.state !== "skipped")
        .map(({ suiteId }) => suiteId),
    ),
  ];
  let error: unknown;
  const details = new Map<number, ControlUiSessionPullRequestCheck>();
  for (const suite of suites.slice(0, MAX_ACTIONS_SUITES)) {
    try {
      if (suite === undefined) {
        throw incomplete();
      }
      const jobs = await loadSuiteJobs(target, suite, rows, request);
      for (const [id, check] of jobs) {
        details.set(id, check);
      }
    } catch (failure) {
      error = failure;
      // The API boundary owns cooldown. Do not repeatedly enter it for the rest of the suites.
      if (failure instanceof ControlUiGitHubError && failure.statusCode === 429) {
        break;
      }
    }
  }
  if (suites.length > MAX_ACTIONS_SUITES && !error) {
    error = new ControlUiGitHubError(
      502,
      "Some Actions steps exceeded the CI detail limit; open the job on GitHub",
    );
  }
  if (suites.length > 0 && !error) {
    const latest = parseChecks(await fetchSessionPullRequestCheckRuns(target, request), target);
    const identity = (values: ParsedCheck[]) =>
      values
        .map(({ check, suiteId }) => `${check.id}:${suiteId ?? ""}`)
        .toSorted()
        .join(",");
    if (identity(latest) !== identity(rows)) {
      throw new ControlUiGitHubError(409, "CI jobs were rerun while loading; reopen CI details");
    }
  }
  return {
    checks: orderedRows
      .map(({ check }) => details.get(check.id) ?? check)
      .toSorted(
        (a, b) =>
          priority[a.state] - priority[b.state] || a.name.localeCompare(b.name) || a.id - b.id,
      ),
    error,
  };
}
