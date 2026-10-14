import fs from "node:fs/promises";
import path from "node:path";
import { isHardlinkFallbackError } from "../infra/directory-durability.js";
import { hasErrnoCode } from "../infra/errno.js";
import { FsSafeError, root as fsRoot } from "../infra/fs-safe.js";
import { readWorkspaceFileWithGuards } from "./workspace-file-read.js";

export class WorkspaceBootstrapSeedConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceBootstrapSeedConflictError";
  }
}

export async function publishBootstrapFile(
  filePath: string,
  content: string | Buffer,
  beforePersistentApply?: () => void,
): Promise<boolean> {
  const dir = await fs.realpath(path.dirname(filePath));
  const targetPath = path.join(dir, path.basename(filePath));
  // Existing entries, including dangling symlinks, need no staging writes.
  // Preserve the exclusive-create no-op on read-only established workspaces.
  const existing = await fs.lstat(targetPath).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  });
  beforePersistentApply?.();
  if (existing) {
    return false;
  }
  const root = await fsRoot(dir);
  try {
    await root.create(targetPath, content, {
      atomic: true,
      durable: "file",
      mkdir: false,
      mode: 0o600,
      assertBeforeMutation: beforePersistentApply,
    });
    return true;
  } catch (error) {
    // A collision with incomplete staging cleanup is still a failure.
    if (error instanceof FsSafeError && error.code === "already-exists" && !error.details) {
      return false;
    }
    if (isHardlinkFallbackError(error instanceof FsSafeError ? error.cause : error)) {
      throw new Error(
        "Workspace filesystem does not support atomic bootstrap publication. Use a workspace on a filesystem with hard-link support.",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function publishAgentInstructions(
  filePath: string,
  template: string,
  purpose: string | undefined,
  beforePersistentApply?: () => void,
): Promise<void> {
  const content = purpose ? `# Agent purpose\n\n${purpose}\n\n${template}` : template;
  const created = await publishBootstrapFile(filePath, content, beforePersistentApply);
  if (purpose && !created) {
    const existing = await readWorkspaceFileWithGuards({
      filePath,
      workspaceDir: path.dirname(filePath),
      useCache: false,
    });
    if (!existing.ok || existing.content !== content) {
      throw new WorkspaceBootstrapSeedConflictError(
        "Existing AGENTS.md was preserved. Choose a new workspace to seed the approved custom purpose.",
      );
    }
  }
}
