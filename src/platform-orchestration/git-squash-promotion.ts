import { execFile } from "node:child_process";
import type {
  GitPromotionPort,
  GitPromotionRequest,
  GitPromotionResult,
} from "./platform-job-ports.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

type GitResult = {
  readonly code: number;
  readonly stdout: string;
};

const SAFE_PROCESS_ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
] as const;

function safeGitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of SAFE_PROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return { ...environment, ...overrides };
}

function runGit(
  repositoryPath: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-replace-objects", ...args],
      {
        cwd: repositoryPath,
        encoding: "utf8",
        env: safeGitEnvironment(env),
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        const code = typeof error?.code === "number" ? error.code : error ? -1 : 0;
        resolve({ code, stdout: stdout.trim() });
      },
    );
  });
}

async function requireGitSuccess(repositoryPath: string, args: readonly string[]): Promise<string> {
  const result = await runGit(repositoryPath, args);
  if (result.code !== 0) {
    throw new Error("git promotion precondition failed");
  }
  return result.stdout;
}

function assertPromotionRequest(request: GitPromotionRequest): void {
  if (
    !COMMIT_SHA_PATTERN.test(request.expectedTargetCommitSha) ||
    !COMMIT_SHA_PATTERN.test(request.sourceCommitSha)
  ) {
    throw new Error("git promotion requires full commit identifiers");
  }
  if (
    !request.commitMessage.trim() ||
    request.commitMessage.length > 200 ||
    /[\r\n]/u.test(request.commitMessage) ||
    request.commitMessage.includes("\u0000")
  ) {
    throw new Error("git promotion commit message is invalid");
  }
  if (!Number.isFinite(Date.parse(request.commitTimestamp))) {
    throw new Error("git promotion commit timestamp is invalid");
  }
}

/**
 * Promotes into a bare repository with Git plumbing only. Requiring a bare repository keeps a
 * checked-out branch from becoming stale when the target ref is atomically advanced.
 */
export class BareGitSquashPromotionAdapter implements GitPromotionPort {
  async promote(request: GitPromotionRequest): Promise<GitPromotionResult> {
    assertPromotionRequest(request);
    const isBare = await requireGitSuccess(request.repositoryPath, [
      "rev-parse",
      "--is-bare-repository",
    ]);
    if (isBare !== "true") {
      throw new Error("git promotion requires a bare repository");
    }
    await requireGitSuccess(request.repositoryPath, [
      "check-ref-format",
      "--branch",
      request.targetBranch,
    ]);

    await requireGitSuccess(request.repositoryPath, [
      "cat-file",
      "-e",
      `${request.sourceCommitSha}^{commit}`,
    ]);
    const ancestry = await runGit(request.repositoryPath, [
      "merge-base",
      "--is-ancestor",
      request.expectedTargetCommitSha,
      request.sourceCommitSha,
    ]);
    if (ancestry.code !== 0) {
      throw new Error("git promotion source is not based on the target revision");
    }

    const sourceTree = await requireGitSuccess(request.repositoryPath, [
      "rev-parse",
      `${request.sourceCommitSha}^{tree}`,
    ]);
    const commit = await runGit(
      request.repositoryPath,
      [
        "commit-tree",
        sourceTree,
        "-p",
        request.expectedTargetCommitSha,
        "-m",
        request.commitMessage,
      ],
      {
        GIT_AUTHOR_NAME: "OpenClaw Core",
        GIT_AUTHOR_EMAIL: "openclaw-core@localhost",
        GIT_AUTHOR_DATE: request.commitTimestamp,
        GIT_COMMITTER_NAME: "OpenClaw Core",
        GIT_COMMITTER_EMAIL: "openclaw-core@localhost",
        GIT_COMMITTER_DATE: request.commitTimestamp,
      },
    );
    if (commit.code !== 0 || !COMMIT_SHA_PATTERN.test(commit.stdout)) {
      throw new Error("git promotion could not create the squash commit");
    }

    const targetRef = `refs/heads/${request.targetBranch}`;
    const currentTarget = await requireGitSuccess(request.repositoryPath, [
      "rev-parse",
      "--verify",
      targetRef,
    ]);
    if (currentTarget === commit.stdout) {
      return {
        promotionId: request.promotionId,
        commitSha: commit.stdout,
        strategy: "squash",
        pushed: false,
      };
    }
    if (currentTarget !== request.expectedTargetCommitSha) {
      throw new Error("git promotion target revision changed");
    }

    const update = await runGit(request.repositoryPath, [
      "update-ref",
      targetRef,
      commit.stdout,
      request.expectedTargetCommitSha,
    ]);
    if (update.code !== 0) {
      throw new Error("git promotion target revision changed");
    }
    return {
      promotionId: request.promotionId,
      commitSha: commit.stdout,
      strategy: "squash",
      pushed: false,
    };
  }
}
