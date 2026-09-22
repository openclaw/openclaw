import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isHardlinkFallbackError } from "../infra/directory-durability.js";
import { hasErrnoCode } from "../infra/errno.js";
import { tempFile } from "../infra/fs-safe-advanced.js";
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
  let cleanupError: unknown;
  const staging = await tempFile({
    rootDir: dir,
    prefix: "openclaw-bootstrap",
    fileName: path.basename(filePath),
    onCleanupError: (error) => {
      cleanupError = error;
    },
  });
  let outcome: { kind: "created" } | { kind: "exists" } | { kind: "failed"; error: unknown };
  try {
    beforePersistentApply?.();
    await fs.writeFile(staging.path, content, { flag: "wx", flush: true });
    beforePersistentApply?.();
    let linked = false;
    try {
      // No await may split these operations: safe readers reject the temporary
      // two-link inode, so publication must reach one link in the same turn.
      syncFs.linkSync(staging.path, targetPath);
      linked = true;
      syncFs.unlinkSync(staging.path);
      outcome = { kind: "created" };
    } catch (error) {
      if (!linked && hasErrnoCode(error, "EEXIST")) {
        outcome = { kind: "exists" };
      } else if (!linked && isHardlinkFallbackError(error)) {
        outcome = {
          kind: "failed",
          error: new Error(
            "Workspace filesystem does not support atomic bootstrap publication. Use a workspace on a filesystem with hard-link support.",
            { cause: error },
          ),
        };
      } else {
        outcome = { kind: "failed", error };
      }
    }
  } catch (error) {
    outcome = { kind: "failed", error };
  }
  await staging.cleanup();
  if (cleanupError !== undefined) {
    if (outcome.kind !== "failed") {
      throw new Error("Workspace bootstrap staging cleanup failed after publication.", {
        cause: cleanupError,
      });
    }
    throw new AggregateError(
      [outcome.error, cleanupError],
      "Workspace bootstrap publication and staging cleanup failed. Remove the incomplete staging directory, then retry.",
      { cause: cleanupError },
    );
  }
  if (outcome.kind === "failed") {
    throw outcome.error;
  }
  return outcome.kind === "created";
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
