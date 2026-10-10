import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";

async function removeTransferArtifact(target: string): Promise<void> {
  await fsp.rm(target, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 0,
    retryDelay: 100,
  });
}

export async function recoverWorkspaceReplacement(workspaceDir: string): Promise<void> {
  const parent = path.dirname(workspaceDir);
  const workspaceName = path.basename(workspaceDir);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const entries = (await fsp.readdir(parent, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && !entry.isSymbolicLink(),
  );
  const stagingPrefix = `.${workspaceName}.workspace-transfer-`;
  const staging = entries.filter((entry) => entry.name.startsWith(stagingPrefix));
  const backups = entries.filter((entry) => entry.name.startsWith(`${workspaceName}.previous-`));
  for (const entry of staging) {
    await removeTransferArtifact(path.join(parent, entry.name));
  }
  const workspaceExists = await fsp
    .lstat(workspaceDir)
    .then((stats) => {
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("workspace transfer target is not an owned directory");
      }
      return true;
    })
    .catch((error: unknown) => {
      if (extractErrorCode(error) === "ENOENT") {
        return false;
      }
      throw error;
    });
  const validBackups = backups.map((entry) => path.join(parent, entry.name));
  if (!workspaceExists) {
    if (validBackups.length > 1) {
      throw new Error("workspace transfer recovery found multiple prior workspaces");
    }
    if (validBackups.length === 1) {
      await fsp.rename(validBackups[0]!, workspaceDir);
    }
    return;
  }
  await Promise.all(
    validBackups.map((backup) => removeTransferArtifact(backup).catch(() => undefined)),
  );
}

export async function replaceNodeWorkerDirectory(
  destination: string,
  staging: string,
  kind: "workspace" | "bundle",
  signal?: AbortSignal,
): Promise<void> {
  const backup = `${destination}.previous-${process.pid}-${randomUUID()}`;
  let movedOld = false;
  signal?.throwIfAborted();
  try {
    await fsp.rename(destination, backup);
    movedOld = true;
  } catch (error) {
    if (extractErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  try {
    // Cancellation after the first rename uses the same rollback as a failed publication.
    signal?.throwIfAborted();
    await fsp.rename(staging, destination);
  } catch (error) {
    if (movedOld && kind === "bundle") {
      await fsp.rename(backup, destination).catch(() => undefined);
    } else if (movedOld) {
      try {
        await fsp.rename(backup, destination);
      } catch (rollbackError) {
        const recoveryError = new Error(`workspace transfer rollback failed; recover ${backup}`, {
          cause: error,
        });
        Object.defineProperty(recoveryError, "rollbackError", {
          value: rollbackError,
        });
        throw recoveryError;
      }
    }
    throw error;
  }
  if (movedOld) {
    // The second rename is the commit point; cleanup failure cannot roll back the new directory.
    await (
      kind === "workspace"
        ? removeTransferArtifact(backup)
        : fsp.rm(backup, { recursive: true, force: true })
    ).catch(() => undefined);
  }
}
