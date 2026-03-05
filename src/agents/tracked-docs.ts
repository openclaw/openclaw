import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceBootstrapFileName } from "./workspace.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
} from "./workspace.js";

// POLICY.md is not exported from workspace.ts — use a local constant.
const DEFAULT_POLICY_FILENAME = "POLICY.md";

/**
 * Filenames that are considered "core workspace documents" and should be change-tracked.
 */
export const TRACKED_DOC_FILENAMES: ReadonlySet<string> = new Set<
  WorkspaceBootstrapFileName | typeof DEFAULT_POLICY_FILENAME
>([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_POLICY_FILENAME,
]);

export type WriteTrackedDocResult = {
  /** Whether a git commit was made. False if git unavailable or no changes. */
  committed: boolean;
  /** The new commit SHA, if committed. */
  sha?: string;
  /** Warning message if git tracking was unavailable. */
  warning?: string;
};

export type DocCommit = {
  sha: string;
  date: string;
  author: string;
  subject: string;
  body?: string;
};

export type DocSessionParams = {
  workspaceDir: string;
  sessionKey: string;
  agentLabel?: string;
};

/**
 * A tracking session.
 *
 * Allows agents to make any number of mutations to workspace documents
 * (raw writes, sed/awk, patch, etc.) and then commit them all at once
 * with a single provenance record.
 *
 * Usage:
 *   const session = await beginDocSession(workspaceDir, { sessionKey, agentLabel });
 *   // ... make changes however you want ...
 *   await session.commit('Added disk hygiene rule');
 */
export type DocSession = {
  /** Commit all currently-dirty tracked docs under a single message. */
  commit(reason: string): Promise<WriteTrackedDocResult>;
  /** Discard the session — leaves files as-is, makes no commit. */
  discard(): void;
};

type GitResult = { code: number; stdout: string; stderr: string };

async function gitCommand(args: string[], cwd: string): Promise<GitResult> {
  try {
    const r = await runCommandWithTimeout(["git", ...args], { cwd, timeoutMs: 10_000 });
    return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr };
  } catch {
    return { code: 1, stdout: "", stderr: "git command failed" };
  }
}

async function hasGitRepo(dir: string): Promise<boolean> {
  try {
    const result = await gitCommand(["rev-parse", "--git-dir"], dir);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Begin a tracked-doc session.
 *
 * The session batches all file mutations made between `beginDocSession()` and
 * `session.commit()` into a single git commit, regardless of how those mutations
 * were made (write, sed, patch, etc.). This avoids noisy per-write commits.
 *
 * Falls back gracefully if git is unavailable.
 */
export async function beginDocSession(params: DocSessionParams): Promise<DocSession> {
  const resolvedDir = resolveUserPath(params.workspaceDir);
  const gitAvailable = await hasGitRepo(resolvedDir);

  const buildBody = (): string =>
    [`Session: ${params.sessionKey}`, params.agentLabel ? `Agent: ${params.agentLabel}` : null]
      .filter(Boolean)
      .join("\n");

  async function commit(reason: string): Promise<WriteTrackedDocResult> {
    if (!gitAvailable) {
      return {
        committed: false,
        warning: `Git repo not found in ${resolvedDir}; changes not tracked.`,
      };
    }

    // Stage only tracked doc filenames that are present and modified.
    const trackedFiles = [...TRACKED_DOC_FILENAMES];
    for (const filename of trackedFiles) {
      // `git add` on a missing file is a no-op — safe to call unconditionally.
      await gitCommand(["add", filename], resolvedDir);
    }

    // Nothing staged → content unchanged.
    const diffResult = await gitCommand(["diff", "--cached", "--quiet"], resolvedDir);
    if (diffResult.code === 0) {
      return { committed: false };
    }

    const subject = `docs: ${reason}`;
    const body = buildBody();

    const commitResult = await gitCommand(
      ["commit", "-m", subject, "-m", body, "--author", "OpenClaw Agent <agent@openclaw.local>"],
      resolvedDir,
    );

    if (commitResult.code !== 0) {
      return { committed: false, warning: `git commit failed: ${commitResult.stderr}` };
    }

    const shaResult = await gitCommand(["rev-parse", "HEAD"], resolvedDir);
    const sha = shaResult.stdout.trim().slice(0, 12) || undefined;

    return { committed: true, sha };
  }

  function discard(): void {
    // No-op: files stay as-is, nothing committed.
  }

  return { commit, discard };
}

/**
 * Write a core workspace document and record the change as a git commit.
 *
 * Convenience wrapper over `beginDocSession` for single-file, single-write mutations.
 * For multi-step or targeted edits (sed/awk/patch), use `beginDocSession` directly.
 *
 * Falls back to plain write if git is unavailable.
 */
export async function writeTrackedDoc(params: {
  workspaceDir: string;
  filename: string;
  content: string;
  sessionKey: string;
  agentLabel?: string;
  reason: string;
}): Promise<WriteTrackedDocResult> {
  const resolvedDir = resolveUserPath(params.workspaceDir);
  const filePath = path.join(resolvedDir, params.filename);

  // Write the file first, then commit via a session.
  await fs.writeFile(filePath, params.content, "utf-8");

  const session = await beginDocSession({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentLabel: params.agentLabel,
  });

  return session.commit(`${params.filename}: ${params.reason}`);
}

/**
 * List git commits that touched a specific workspace document.
 */
export async function getDocHistory(params: {
  workspaceDir: string;
  filename: string;
  limit?: number;
}): Promise<DocCommit[]> {
  const resolvedDir = resolveUserPath(params.workspaceDir);
  const limit = params.limit ?? 20;

  const result = await gitCommand(
    [
      "log",
      `--max-count=${limit}`,
      "--format=%H%x00%ai%x00%an%x00%s%x00%b%x00---COMMIT---",
      "--",
      params.filename,
    ],
    resolvedDir,
  );

  if (result.code !== 0 || !result.stdout.trim()) {
    return [];
  }

  return result.stdout
    .split("---COMMIT---")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, date, author, subject, body] = chunk.split("\x00");
      return {
        sha: (sha ?? "").slice(0, 12),
        date: (date ?? "").trim(),
        author: (author ?? "").trim(),
        subject: (subject ?? "").trim(),
        body: (body ?? "").trim() || undefined,
      };
    })
    .filter((c) => c.sha);
}

/**
 * Get the content of a workspace document at a specific commit.
 */
export async function getDocAtCommit(params: {
  workspaceDir: string;
  filename: string;
  sha: string;
}): Promise<string | null> {
  const resolvedDir = resolveUserPath(params.workspaceDir);
  const result = await gitCommand(["show", `${params.sha}:${params.filename}`], resolvedDir);
  if (result.code !== 0) {
    return null;
  }
  return result.stdout;
}

/**
 * Get a unified diff for a workspace document between two commits (or HEAD vs a commit).
 */
export async function getDocDiff(params: {
  workspaceDir: string;
  filename: string;
  fromSha: string;
  toSha?: string; // defaults to working tree
}): Promise<string> {
  const resolvedDir = resolveUserPath(params.workspaceDir);
  const to = params.toSha ?? "";
  const args = to
    ? ["diff", params.fromSha, to, "--", params.filename]
    : ["diff", params.fromSha, "--", params.filename];

  const result = await gitCommand(args, resolvedDir);
  return result.stdout;
}

/**
 * Roll back a workspace document to a specific commit, recording the rollback as a new commit.
 */
export async function rollbackDoc(params: {
  workspaceDir: string;
  filename: string;
  sha: string;
  sessionKey: string;
  agentLabel?: string;
}): Promise<WriteTrackedDocResult> {
  const content = await getDocAtCommit({
    workspaceDir: params.workspaceDir,
    filename: params.filename,
    sha: params.sha,
  });

  if (content === null) {
    return {
      committed: false,
      warning: `Could not find ${params.filename} at commit ${params.sha}`,
    };
  }

  return writeTrackedDoc({
    workspaceDir: params.workspaceDir,
    filename: params.filename,
    content,
    sessionKey: params.sessionKey,
    agentLabel: params.agentLabel,
    reason: `rollback to ${params.sha}`,
  });
}
