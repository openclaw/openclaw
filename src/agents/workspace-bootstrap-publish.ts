import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { lstatIfExists } from "../infra/path-existence.js";
import { createWorkspaceFileMutationGuard } from "./workspace-file-mutation-guard.js";
import { runWorkspaceFilesystemOperation } from "./workspace-filesystem.js";
import type { WorkspaceStateGuard } from "./workspace-state-store.worker-contract.js";

export class WorkspaceBootstrapSeedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBootstrapSeedConflictError";
  }
}

export async function publishBootstrapFile(
  filePath: string,
  content: string | Buffer | (() => Promise<string>),
  guard?: WorkspaceStateGuard,
): Promise<boolean> {
  const dir = await fs.realpath(path.dirname(filePath));
  const targetPath = path.join(dir, path.basename(filePath));
  // Existing entries, including dangling symlinks, need no staging writes.
  // Preserve the exclusive-create no-op on read-only established workspaces.
  const existing = await lstatIfExists(targetPath, "ENOENT");
  createWorkspaceFileMutationGuard(guard)?.();
  if (existing) {
    return false;
  }
  const resolvedContent = typeof content === "function" ? await content() : content;
  return runWorkspaceFilesystemOperation(
    {
      kind: "publish",
      dir: guard?.filesystem?.length ? path.dirname(filePath) : dir,
      name: path.basename(filePath),
      content: resolvedContent,
    },
    guard,
  );
}

export async function publishAgentInstructions(
  filePath: string,
  template: () => Promise<string>,
  purpose: string | undefined,
  guard?: WorkspaceStateGuard,
): Promise<void> {
  if (!purpose) {
    await publishBootstrapFile(filePath, template, guard);
    return;
  }
  const content = `# Agent purpose\n\n${purpose}\n\n${await template()}`;
  try {
    await runWorkspaceFilesystemOperation(
      { kind: "purpose", dir: path.dirname(filePath), name: path.basename(filePath), content },
      guard,
    );
  } catch (error) {
    if (hasErrnoCode(error, "WORKSPACE_BOOTSTRAP_SEED_CONFLICT") && error instanceof Error) {
      throw new WorkspaceBootstrapSeedConflictError(error.message);
    }
    throw error;
  }
}
