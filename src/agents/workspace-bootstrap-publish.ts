import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { tempFile } from "@openclaw/fs-safe/advanced";
import {
  isHardlinkFallbackError,
  syncDirectoryIfSupported,
} from "../infra/directory-durability.js";
import { hasErrnoCode } from "../infra/errno.js";
import { FsSafeError, root as fsSafeRoot } from "../infra/fs-safe.js";
import { readWorkspaceFileWithGuards } from "./workspace-file-read.js";

export class WorkspaceBootstrapSeedConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceBootstrapSeedConflictError";
  }
}

/** Exact file identity, recorded before publication and refreshed while the object is pinned. */
export type BootstrapPublicationIdentity = {
  directoryPath: string;
  directoryDev: string;
  directoryIno: string;
  dev: string;
  ino: string;
  birthtimeNs: string;
};

/** Publish a complete bootstrap without replacing an existing entry. */
export async function publishBootstrapFile(
  filePath: string,
  content: string | Buffer,
  beforePersistentApply?: () => void,
  beforePublish?: (identity: BootstrapPublicationIdentity) => void,
  mode = 0o666 & ~process.umask(),
  afterPublish?: (identity: BootstrapPublicationIdentity) => void,
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
  // Root.create exposes neither the staged identity nor a pinned completion callback.
  // Adoption needs a write-ahead receipt and its final identity before the descriptor closes.
  const workspaceRoot = await fsSafeRoot(dir, { hardlinks: "reject", symlinks: "reject" });
  const directory = await fs.lstat(dir, { bigint: true });
  let cleanupError: unknown;
  const staging = await tempFile({
    rootDir: dir,
    prefix: "openclaw-bootstrap",
    fileName: path.basename(filePath),
    onCleanupError: (error) => {
      cleanupError = error;
    },
  });
  let stagedFile: Awaited<ReturnType<typeof workspaceRoot.open>> | undefined;
  let outcome: { kind: "created" } | { kind: "exists" } | { kind: "failed"; error: unknown };
  try {
    beforePersistentApply?.();
    await workspaceRoot.write(path.relative(dir, staging.path), content, {
      overwrite: false,
      mode,
      assertBeforeMutation: beforePersistentApply,
    });
    stagedFile = await workspaceRoot.open(path.relative(dir, staging.path));
    const identity = syncFs.fstatSync(stagedFile.handle.fd, { bigint: true });
    const assertIdentity = (observedPath: string) => {
      beforePersistentApply?.();
      const currentDirectory = syncFs.lstatSync(dir, { bigint: true });
      const currentFile = syncFs.lstatSync(observedPath, { bigint: true });
      if (
        !currentDirectory.isDirectory() ||
        currentDirectory.dev !== directory.dev ||
        currentDirectory.ino !== directory.ino ||
        !currentFile.isFile() ||
        currentFile.dev !== identity.dev ||
        currentFile.ino !== identity.ino ||
        currentFile.nlink !== 1n ||
        currentFile.size !== identity.size ||
        currentFile.mtimeNs !== identity.mtimeNs
      ) {
        throw new Error("Workspace bootstrap file identity changed during publication.");
      }
    };
    const publication: BootstrapPublicationIdentity = {
      directoryPath: dir,
      directoryDev: directory.dev.toString(),
      directoryIno: directory.ino.toString(),
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
      birthtimeNs: identity.birthtimeNs.toString(),
    };
    const assertPublication = () => {
      assertIdentity(staging.path);
      beforePublish?.(publication);
      assertIdentity(staging.path);
    };
    assertPublication();
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
        // Native no-replace rename preserves Root.write's support for filesystems without
        // hardlinks. Windows/portable publication retains the same-turn link/unlink path.
        await workspaceRoot.move(path.relative(dir, staging.path), path.basename(targetPath), {
          overwrite: false,
          mutationSymlinks: "reject",
          assertBeforeMutation: assertPublication,
        });
        outcome = { kind: "created" };
      } else {
        outcome = { kind: "failed", error };
      }
    }
    if (outcome.kind === "created" && afterPublish) {
      // Some filesystems report change-time as birth-time. The retained descriptor prevents
      // inode reuse while we bind the final name and refreshed receipt to our original file.
      assertIdentity(targetPath);
      const published = syncFs.fstatSync(stagedFile.handle.fd, { bigint: true });
      afterPublish({ ...publication, birthtimeNs: published.birthtimeNs.toString() });
      assertIdentity(targetPath);
    }
  } catch (error) {
    outcome =
      error instanceof FsSafeError && error.code === "already-exists" && !error.details
        ? { kind: "exists" }
        : { kind: "failed", error };
  }
  try {
    await stagedFile?.handle.close();
  } finally {
    await staging.cleanup();
  }
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
  if (outcome.kind === "created") {
    await syncDirectoryIfSupported(dir);
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
