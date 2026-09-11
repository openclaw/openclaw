import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import type { SandboxBackendInternalMount } from "../sandbox/backend.types.js";
import { listRegistryWorktrees } from "./registry.js";
import { markRegistryRepositorySandboxGit } from "./repository-provenance.js";

function resolveGitdirPointer(raw: string, dotGitPath: string): string | undefined {
  const match = /^gitdir:\s*(.+)\s*$/i.exec(raw.trim());
  if (!match?.[1]) {
    return undefined;
  }
  return path.resolve(path.dirname(dotGitPath), match[1]);
}

/**
 * Resolve the shared Git metadata bind required by a registered linked worktree.
 * The registry and reciprocal Git backlink, not the writable pointer alone, grant the mount.
 */
export async function resolveManagedWorktreeGitMount(params: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  writableBySessionKey?: string;
}): Promise<SandboxBackendInternalMount | undefined> {
  const workspace = await fs.realpath(params.workspaceDir);
  const dotGitPath = path.join(workspace, ".git");
  const stat = await fs.lstat(dotGitPath).catch(() => undefined);
  if (!stat || stat.isDirectory()) {
    return undefined;
  }
  const record = listRegistryWorktrees(params.env ?? process.env).find(
    (candidate) => candidate.removedAt === undefined && path.resolve(candidate.path) === workspace,
  );
  if (!record) {
    return undefined;
  }
  const env = params.env ?? process.env;
  if (
    params.writableBySessionKey &&
    !markRegistryRepositorySandboxGit({
      env,
      record,
      ownerId: params.writableBySessionKey,
    })
  ) {
    throw new Error(
      "Writable sandbox access to managed Git metadata requires a live worktree owned by this session.",
    );
  }
  if (!stat.isFile()) {
    throw new Error("Managed worktree Git metadata pointer is not a regular file.");
  }
  const commonDir = await fs.realpath(path.join(record.repoRoot, ".git"));
  const worktreeMetadataRoot = path.join(commonDir, "worktrees");
  const pointer = resolveGitdirPointer(await fs.readFile(dotGitPath, "utf8"), dotGitPath);
  if (!pointer) {
    throw new Error("Managed worktree Git metadata pointer is invalid.");
  }
  const gitdir = await fs.realpath(pointer).catch(() => undefined);
  if (!gitdir) {
    throw new Error("Managed worktree Git metadata pointer target is unavailable.");
  }
  if (!isPathInside(worktreeMetadataRoot, gitdir)) {
    throw new Error("Managed worktree Git metadata pointer escaped its registered repository.");
  }
  const backlinkRaw = (await fs.readFile(path.join(gitdir, "gitdir"), "utf8")).trim();
  const backlink = path.resolve(gitdir, backlinkRaw);
  if (path.resolve(backlink) !== dotGitPath) {
    throw new Error("Managed worktree Git metadata backlink does not match its registry path.");
  }
  return {
    hostPath: commonDir,
    containerPath: commonDir,
    readOnly: params.writableBySessionKey === undefined,
  };
}
