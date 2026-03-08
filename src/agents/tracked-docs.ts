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

/**
 * Filenames that are considered "core workspace documents" and should be change-tracked.
 */
export const TRACKED_DOC_FILENAMES: ReadonlySet<string> = new Set<WorkspaceBootstrapFileName>([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  "POLICY.md",
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

async function gitCommand(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    return await runCommandWithTimeout(["git", ...args], { cwd, timeoutMs: 10_000 });
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
 * Write a core workspace document and record the change as a git commit.
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

  // Always write the file first.
  await fs.writeFile(filePath, params.content, "utf-8");

  if (!(await hasGitRepo(resolvedDir))) {
    return {
      committed: false,
      warning: `Git repo not found in ${resolvedDir}; change not tracked.`,
    };
  }

  // Stage the file.
  const addResult = await gitCommand(["add", params.filename], resolvedDir);
  if (addResult.code !== 0) {
    return { committed: false, warning: `git add failed: ${addResult.stderr}` };
  }

  // Check if there's actually anything to commit.
  const diffResult = await gitCommand(["diff", "--cached", "--quiet"], resolvedDir);
  if (diffResult.code === 0) {
    // Nothing staged — content was identical.
    return { committed: false };
  }

  // Build commit message.
  const subject = `docs(${params.filename}): ${params.reason}`;
  const body = [
    `Session: ${params.sessionKey}`,
    params.agentLabel ? `Agent: ${params.agentLabel}` : null,
    `Filename: ${params.filename}`,
  ]
    .filter(Boolean)
    .join("\n");

  const commitResult = await gitCommand(
    ["commit", "-m", subject, "-m", body, "--author", "OpenClaw Agent <agent@openclaw.local>"],
    resolvedDir,
  );

  if (commitResult.code !== 0) {
    return { committed: false, warning: `git commit failed: ${commitResult.stderr}` };
  }

  // Retrieve the new commit SHA.
  const shaResult = await gitCommand(["rev-parse", "HEAD"], resolvedDir);
  const sha = shaResult.stdout.trim().slice(0, 12) || undefined;

  return { committed: true, sha };
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
