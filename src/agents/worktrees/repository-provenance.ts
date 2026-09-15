import fs from "node:fs/promises";
import path from "node:path";
import type { WorktreeGitIsolation } from "./git-isolation.js";
import { findGitCheckoutRoot } from "./git.js";
import { listRegistryWorktrees } from "./registry.js";
import {
  getRegistryRepositoryGitIsolation,
  setRegistryRepositorySandboxGit,
} from "./repository-isolation-store.js";
import type { ManagedWorktreeRecord } from "./types.js";

/** Resolve the primary checkout root without invoking repository-selected Git behavior. */
export async function resolveRepositoryIsolationRoot(
  workspaceDir: string,
): Promise<string | undefined> {
  const workspace = await fs.realpath(workspaceDir);
  const checkoutRoot = findGitCheckoutRoot(workspace);
  if (!checkoutRoot) {
    return undefined;
  }
  const canonicalCheckout = await fs.realpath(checkoutRoot);
  const dotGit = path.join(canonicalCheckout, ".git");
  const stat = await fs.lstat(dotGit).catch(() => undefined);
  if (stat?.isDirectory()) {
    return canonicalCheckout;
  }
  if (!stat?.isFile()) {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)\s*$/i.exec((await fs.readFile(dotGit, "utf8")).trim());
  if (!match?.[1]) {
    return undefined;
  }
  const gitdir = await fs.realpath(path.resolve(path.dirname(dotGit), match[1]));
  const commonRaw = await fs
    .readFile(path.join(gitdir, "commondir"), "utf8")
    .catch(() => undefined);
  if (!commonRaw) {
    return undefined;
  }
  const commonDir = await fs.realpath(path.resolve(gitdir, commonRaw.trim()));
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : undefined;
}

export function isRegisteredRepositoryDestination(params: {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  destination: string;
}): boolean {
  return listRegistryWorktrees(params.env).some(
    (record) =>
      record.repoRoot === params.repoRoot && path.resolve(record.path) === params.destination,
  );
}

/** Persist repository-wide containment before returning a writable shared metadata mount. */
export function markRegistryRepositorySandboxGit(params: {
  env: NodeJS.ProcessEnv;
  record: Pick<ManagedWorktreeRecord, "id" | "repoRoot">;
  ownerId: string;
  agentId?: string;
}): boolean {
  const record = listRegistryWorktrees(params.env).find(
    (candidate) => candidate.id === params.record.id,
  );
  if (
    !record ||
    record.removedAt !== undefined ||
    (record.sandboxGit !== true &&
      (record.ownerKind !== "session" || record.ownerId !== params.ownerId))
  ) {
    return false;
  }
  setRegistryRepositorySandboxGit(params.env, params.record.repoRoot, {
    sessionKey: params.ownerId,
    agentId: params.agentId,
  });
  return true;
}

/** Persist containment before the primary checkout is mounted into provisioning. */
export function markRegistryRepositorySandboxGitByRoot(params: {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  isolation: Pick<WorktreeGitIsolation, "sessionKey" | "agentId">;
}): void {
  setRegistryRepositorySandboxGit(params.env, params.repoRoot, params.isolation);
}

export function resolveRegistryRepositoryGitIsolation(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): Pick<WorktreeGitIsolation, "sessionKey" | "agentId"> | undefined {
  return getRegistryRepositoryGitIsolation(env, repoRoot);
}
