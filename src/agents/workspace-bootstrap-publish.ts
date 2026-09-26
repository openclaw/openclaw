import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { tempFile } from "@openclaw/fs-safe/advanced";
import {
  isHardlinkFallbackError,
  syncDirectoryIfSupported,
} from "../infra/directory-durability.js";
import { hasErrnoCode } from "../infra/errno.js";
import { FsSafeError, isPathInside, root as fsSafeRoot } from "../infra/fs-safe.js";
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
  mode = 0o600,
  afterPublish?: (identity: BootstrapPublicationIdentity) => void,
  boundaryRoot?: string,
): Promise<boolean> {
  const dir = await fs.realpath(path.dirname(filePath));
  if (boundaryRoot) {
    const boundary = path.resolve(boundaryRoot);
    if (dir !== boundary && !isPathInside(boundary, dir)) {
      throw new Error("Workspace bootstrap destination escaped its publication boundary.");
    }
  }
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
  if (!beforePublish && !afterPublish) {
    const root = await fsSafeRoot(dir);
    try {
      await root.create(targetPath, content, {
        atomic: true,
        durable: "file",
        mkdir: false,
        mode,
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

  const workspaceRoot = await fsSafeRoot(dir, { hardlinks: "reject", symlinks: "reject" });
  const directory = await fs.lstat(dir, { bigint: true });
  const expectedContent = Buffer.from(content);
  let cleanupError: unknown;
  const staging = await tempFile({
    rootDir: dir,
    prefix: "openclaw-bootstrap",
    fileName: path.basename(filePath),
    cleanupSafety: "require-bounded",
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
    const assertContent = () => {
      const observed = Buffer.alloc(expectedContent.length);
      let offset = 0;
      while (offset < observed.length) {
        const bytesRead = syncFs.readSync(
          stagedFile!.handle.fd,
          observed,
          offset,
          observed.length - offset,
          offset,
        );
        if (bytesRead === 0) {
          break;
        }
        offset += bytesRead;
      }
      const grew = syncFs.readSync(
        stagedFile!.handle.fd,
        Buffer.alloc(1),
        0,
        1,
        expectedContent.length,
      );
      if (offset !== observed.length || grew !== 0 || !observed.equals(expectedContent)) {
        throw new Error("Workspace bootstrap file content changed during publication.");
      }
    };
    const assertFileIdentity = (currentFile: syncFs.BigIntStats) => {
      if (
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
    const assertIdentity = (observedPath: string) => {
      beforePersistentApply?.();
      const currentDirectory = syncFs.lstatSync(dir, { bigint: true });
      const currentFile = syncFs.lstatSync(observedPath, { bigint: true });
      if (
        !currentDirectory.isDirectory() ||
        currentDirectory.dev !== directory.dev ||
        currentDirectory.ino !== directory.ino
      ) {
        throw new Error("Workspace bootstrap directory identity changed during publication.");
      }
      assertFileIdentity(currentFile);
      assertContent();
      assertFileIdentity(syncFs.fstatSync(stagedFile!.handle.fd, { bigint: true }));
      assertFileIdentity(syncFs.lstatSync(observedPath, { bigint: true }));
    };
    const publication: BootstrapPublicationIdentity = {
      directoryPath: dir,
      directoryDev: directory.dev.toString(),
      directoryIno: directory.ino.toString(),
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
      birthtimeNs: identity.birthtimeNs.toString(),
    };
    const recordPublication = () => {
      assertIdentity(staging.path);
      beforePublish?.(publication);
      assertIdentity(staging.path);
    };
    recordPublication();
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
        try {
          await workspaceRoot.move(path.relative(dir, staging.path), path.basename(targetPath), {
            overwrite: false,
            mutationSymlinks: "reject",
            assertBeforeMutation: () => assertIdentity(staging.path),
          });
          outcome = { kind: "created" };
        } catch (moveError) {
          outcome =
            moveError instanceof FsSafeError &&
            moveError.code === "already-exists" &&
            !moveError.details
              ? { kind: "exists" }
              : { kind: "failed", error: moveError };
        }
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
    outcome = { kind: "failed", error };
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
