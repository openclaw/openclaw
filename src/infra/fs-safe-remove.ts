// Safe recursive removal without coupling the file-access surface to log redaction.
import "./fs-safe-defaults.js";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as fsSafeRoot } from "@openclaw/fs-safe/root";
import { isMissingPathError } from "./errno.js";

function isNotFoundError(error: unknown): boolean {
  return isMissingPathError(error) || isMissingPathError(findMappedFilesystemCause(error));
}

function findMappedFilesystemCause(error: unknown): NodeJS.ErrnoException | undefined {
  const removalObservation =
    error instanceof FsSafeError &&
    error.details?.operation === "remove" &&
    (error.details.phase === "enumerate" || error.details.phase === "inspect");
  if ((error as NodeJS.ErrnoException | undefined)?.code !== "path-alias" && !removalObservation) {
    return undefined;
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeCode = (cause as NodeJS.ErrnoException | undefined)?.code;
  return typeof causeCode === "string" && /^E[A-Z0-9_]+$/u.test(causeCode)
    ? (cause as NodeJS.ErrnoException)
    : undefined;
}

export async function removePathWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  recursive?: boolean;
  force?: boolean;
}): Promise<void> {
  const root = await fsSafeRoot(params.rootDir);
  const suppressNotFound = params.force !== false;
  const recursive = params.recursive === true;
  try {
    await root.remove(params.relativePath, {
      recursive,
      force: suppressNotFound,
      mutationSymlinks: "follow-parents-within-root",
      ...(recursive ? { order: "sorted" as const, maxEntries: Infinity, maxDepth: Infinity } : {}),
    });
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "symlink") {
      const descendantPath =
        error.details?.operation === "remove" && typeof error.details.relativePath === "string"
          ? error.details.relativePath
          : "";
      const relativePath = descendantPath
        ? path.join(params.relativePath, descendantPath)
        : params.relativePath;
      throw new FsSafeError("symlink", `symlink not allowed: ${relativePath}`);
    }
    if (isNotFoundError(error)) {
      if (suppressNotFound) {
        return;
      }
      throw new FsSafeError("not-found", "file not found", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    const filesystemCause = findMappedFilesystemCause(error);
    if (filesystemCause) {
      throw filesystemCause;
    }
    throw error;
  }
}
