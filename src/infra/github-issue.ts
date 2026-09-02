/** Creates sanitized OpenClaw GitHub issues through the installed GitHub CLI. */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

export type SanitizedGithubIssue = {
  body: string;
  title: string;
  url: string;
};

export type GithubIssueCreateResult =
  | { ok: true; url: string }
  | { ambiguous: true; message: string; ok: false }
  | {
      ambiguous?: false;
      issueCreateStarted: false;
      message: string;
      ok: false;
      retryable: true;
    }
  | {
      ambiguous?: false;
      fallbackUrl: string;
      issueCreateStarted: false;
      message: string;
      ok: false;
    };

type SpawnGh = (args: readonly string[], options: { input: string }) => GithubCliResult;

type GithubCliResult = Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "stderr" | "stdout"> & {
  started?: boolean;
};
type RunGhAsync = (args: readonly string[], options: { input: string }) => Promise<GithubCliResult>;

export type GithubIssueCreateAsyncHooks = {
  afterAuthPreflight?: () => Promise<void> | void;
  beforeIssueCreate?: () => Promise<void> | void;
};

const GITHUB_ISSUE_CREATE_TIMEOUT_MS = 30_000;
const GITHUB_PREFILL_BODY_MAX_BYTES = 6_000;
const GITHUB_PREFILL_TITLE_MAX_BYTES = 512;
const GITHUB_PREFILL_URL_MAX_CHARS = 16_384;
const GITHUB_PREFILL_TRUNCATED_SUFFIX =
  "\n\n...(truncated for URL; see the saved sanitized report for the complete body)";
const GITHUB_AUTH_PREFLIGHT_ARGS = [
  "api",
  "user",
  "--hostname",
  "github.com",
  "--method",
  "GET",
  "--silent",
] as const;

function githubIssueCreateArgs(issue: SanitizedGithubIssue): readonly string[] {
  return [
    "issue",
    "create",
    "--repo",
    "github.com/openclaw/openclaw",
    "--title",
    issue.title,
    "--body-file",
    "-",
  ];
}

function buildPrefilledGithubIssueUrl(title: string, body: string): string {
  const params = new URLSearchParams({ body, title });
  return `https://github.com/openclaw/openclaw/issues/new?${params.toString()}`;
}

/** Builds the browser handoff used when the authenticated GitHub CLI is unavailable. */
export function createPrefilledGithubIssueUrl(title: string, body: string): string {
  const boundedTitle = truncateUtf8Prefix(title, GITHUB_PREFILL_TITLE_MAX_BYTES);
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes <= GITHUB_PREFILL_BODY_MAX_BYTES) {
    const fullUrl = buildPrefilledGithubIssueUrl(boundedTitle, body);
    if (fullUrl.length <= GITHUB_PREFILL_URL_MAX_CHARS) {
      return fullUrl;
    }
  }

  let low = 0;
  let high = Math.min(bodyBytes, GITHUB_PREFILL_BODY_MAX_BYTES);
  let boundedUrl = buildPrefilledGithubIssueUrl(boundedTitle, GITHUB_PREFILL_TRUNCATED_SUFFIX);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = buildPrefilledGithubIssueUrl(
      boundedTitle,
      `${truncateUtf8Prefix(body, middle)}${GITHUB_PREFILL_TRUNCATED_SUFFIX}`,
    );
    if (candidate.length <= GITHUB_PREFILL_URL_MAX_CHARS) {
      boundedUrl = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return boundedUrl;
}

/** Creates an openclaw/openclaw issue through the GitHub CLI using sanitized stdin. */
export function createGithubIssue(
  issue: SanitizedGithubIssue,
  spawnGh: SpawnGh = defaultSpawnGh,
): GithubIssueCreateResult {
  const authResult = spawnGh(GITHUB_AUTH_PREFLIGHT_ARGS, { input: "" });
  if (authResult.error || authResult.status !== 0) {
    return resolveGithubAuthPreflightFailure(issue, authResult);
  }
  return resolveGithubIssueCreateResult(
    issue,
    spawnGh(githubIssueCreateArgs(issue), { input: issue.body }),
  );
}

/** Async issue creation for Gateway request paths; never blocks the event loop on `gh`. */
export async function createGithubIssueAsync(
  issue: SanitizedGithubIssue,
  runGh: RunGhAsync = defaultRunGhAsync,
  hooks: GithubIssueCreateAsyncHooks = {},
): Promise<GithubIssueCreateResult> {
  const authResult = await runGh(GITHUB_AUTH_PREFLIGHT_ARGS, { input: "" });
  await hooks.afterAuthPreflight?.();
  if (authResult.error || authResult.status !== 0) {
    return resolveGithubAuthPreflightFailure(issue, authResult);
  }
  await hooks.beforeIssueCreate?.();
  return resolveGithubIssueCreateResult(
    issue,
    await runGh(githubIssueCreateArgs(issue), { input: issue.body }),
  );
}

function githubCliFailureMessage(result: GithubCliResult): string {
  const stderr = String(result.stderr).trim();
  return result.error?.message ?? (stderr || `gh exited ${result.status ?? "unknown"}`);
}

function resolveGithubAuthPreflightFailure(
  issue: SanitizedGithubIssue,
  result: GithubCliResult,
): GithubIssueCreateResult {
  return {
    fallbackUrl: issue.url,
    issueCreateStarted: false,
    message: githubCliFailureMessage(result),
    ok: false,
  };
}

function resolveGithubIssueCreateResult(
  issue: SanitizedGithubIssue,
  result: GithubCliResult,
): GithubIssueCreateResult {
  const outputUrl = String(result.stdout).trim().split(/\r?\n/).at(-1);
  try {
    const parsed = new URL(outputUrl ?? "");
    if (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      /^\/openclaw\/openclaw\/issues\/\d+$/u.test(parsed.pathname)
    ) {
      return { ok: true, url: parsed.toString() };
    }
  } catch {
    // A child that started without returning a validated issue URL remains ambiguous.
  }
  const error =
    !result.error && result.status === 0
      ? "gh completed without a validated GitHub issue URL"
      : githubCliFailureMessage(result);
  const errorCode =
    result.error && "code" in result.error && typeof result.error.code === "string"
      ? result.error.code
      : undefined;
  const definitelyUnstarted =
    result.started === false &&
    result.error !== undefined &&
    (result.status === null || result.status < 0) &&
    errorCode !== "ETIMEDOUT";
  if (!definitelyUnstarted) {
    return { ambiguous: true, message: error, ok: false };
  }
  if (errorCode === "ENOENT" || errorCode === "EACCES" || errorCode === "EPERM") {
    return { fallbackUrl: issue.url, issueCreateStarted: false, message: error, ok: false };
  }
  return { issueCreateStarted: false, message: error, ok: false, retryable: true };
}

function testProcessBlockResult(): GithubCliResult {
  return {
    error: Object.assign(
      new Error("External GitHub issue creation is disabled in test processes."),
      { code: "EPERM" },
    ),
    status: null,
    started: false,
    stderr: Buffer.alloc(0),
    stdout: Buffer.alloc(0),
  };
}

async function defaultRunGhAsync(
  args: readonly string[],
  options: { input: string },
): Promise<GithubCliResult> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return testProcessBlockResult();
  }
  return await new Promise<GithubCliResult>((resolve) => {
    const child = spawn("gh", [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let error: Error | undefined;
    let settled = false;
    let started = false;
    const settle = (status: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ...(error ? { error } : {}),
        status,
        started,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    };
    const appendBounded = (chunks: Buffer[], chunk: Buffer, currentBytes: number): number => {
      const remaining = 1024 * 1024 - currentBytes;
      if (remaining <= 0) {
        return currentBytes;
      }
      chunks.push(chunk.subarray(0, remaining));
      return currentBytes + Math.min(chunk.byteLength, remaining);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = appendBounded(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = appendBounded(stderr, chunk, stderrBytes);
    });
    child.on("error", (spawnError) => {
      error = spawnError;
    });
    child.on("spawn", () => {
      started = true;
    });
    const timeout = setTimeout(() => {
      const message =
        args[0] === "api"
          ? "GitHub CLI authentication check timed out"
          : "GitHub issue creation timed out";
      error = Object.assign(new Error(message), { code: "ETIMEDOUT" });
      child.kill("SIGKILL");
      settle(null);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }, GITHUB_ISSUE_CREATE_TIMEOUT_MS);
    timeout.unref?.();
    child.on("close", settle);
    child.stdin.on("error", () => {
      // The process result owns the actionable error and fallback.
    });
    child.stdin.end(options.input);
  });
}

function defaultSpawnGh(args: readonly string[], options: { input: string }): GithubCliResult {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return testProcessBlockResult();
  }
  const result = spawnSync("gh", [...args], {
    input: options.input,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    timeout: GITHUB_ISSUE_CREATE_TIMEOUT_MS,
  });
  return {
    ...result,
    started: typeof result.pid === "number" && Number.isInteger(result.pid) && result.pid > 0,
  };
}
