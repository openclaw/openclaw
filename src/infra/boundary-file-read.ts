import fs from "node:fs";
import path from "node:path";
import { assertNoPathAliasEscape, type PathAliasPolicy } from "./path-alias-guards.js";
import { isNotFoundPathError, isPathInside } from "./path-guards.js";
import { openVerifiedFileSync, type SafeOpenSyncFailureReason } from "./safe-open-sync.js";

type BoundaryReadFs = Pick<
  typeof fs,
  | "closeSync"
  | "constants"
  | "fstatSync"
  | "lstatSync"
  | "openSync"
  | "readFileSync"
  | "realpathSync"
>;

export type BoundaryFileOpenFailureReason = SafeOpenSyncFailureReason | "validation";

export type BoundaryFileOpenResult =
  | { ok: true; path: string; fd: number; stat: fs.Stats; rootRealPath: string }
  | { ok: false; reason: BoundaryFileOpenFailureReason; error?: unknown };

export type OpenBoundaryFileSyncParams = {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  rootRealPath?: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  skipLexicalRootCheck?: boolean;
  ioFs?: BoundaryReadFs;
};

export type OpenBoundaryFileParams = OpenBoundaryFileSyncParams & {
  aliasPolicy?: PathAliasPolicy;
};

function safeRealpathSync(ioFs: Pick<typeof fs, "realpathSync">, value: string): string {
  try {
    return path.resolve(ioFs.realpathSync(value));
  } catch {
    return path.resolve(value);
  }
}

export function canUseBoundaryFileOpen(ioFs: typeof fs): boolean {
  return (
    typeof ioFs.openSync === "function" &&
    typeof ioFs.closeSync === "function" &&
    typeof ioFs.fstatSync === "function" &&
    typeof ioFs.lstatSync === "function" &&
    typeof ioFs.realpathSync === "function" &&
    typeof ioFs.readFileSync === "function" &&
    typeof ioFs.constants === "object" &&
    ioFs.constants !== null
  );
}

export function openBoundaryFileSync(params: OpenBoundaryFileSyncParams): BoundaryFileOpenResult {
  const ioFs = params.ioFs ?? fs;
  const absolutePath = path.resolve(params.absolutePath);
  const rootPath = path.resolve(params.rootPath);
  const rootRealPath = params.rootRealPath
    ? path.resolve(params.rootRealPath)
    : safeRealpathSync(ioFs, rootPath);

  let resolvedPath = absolutePath;
  const lexicalInsideRoot = isPathInside(rootPath, absolutePath);
  try {
    const candidateRealPath = path.resolve(ioFs.realpathSync(absolutePath));
    if (
      !params.skipLexicalRootCheck &&
      !lexicalInsideRoot &&
      !isPathInside(rootRealPath, candidateRealPath)
    ) {
      return {
        ok: false,
        reason: "validation",
        error: new Error(
          `Path escapes ${params.boundaryLabel}: ${absolutePath} (root: ${rootPath})`,
        ),
      };
    }
    if (!isPathInside(rootRealPath, candidateRealPath)) {
      return {
        ok: false,
        reason: "validation",
        error: new Error(
          `Path resolves outside ${params.boundaryLabel}: ${absolutePath} (root: ${rootRealPath})`,
        ),
      };
    }
    resolvedPath = candidateRealPath;
  } catch (error) {
    if (!params.skipLexicalRootCheck && !lexicalInsideRoot) {
      return {
        ok: false,
        reason: "validation",
        error: new Error(
          `Path escapes ${params.boundaryLabel}: ${absolutePath} (root: ${rootPath})`,
        ),
      };
    }
    if (!isNotFoundPathError(error)) {
      // Keep resolvedPath as lexical path; openVerifiedFileSync below will produce
      // a canonical error classification for missing/unreadable targets.
    }
  }

  const opened = openVerifiedFileSync({
    filePath: absolutePath,
    resolvedPath,
    rejectHardlinks: params.rejectHardlinks ?? true,
    maxBytes: params.maxBytes,
    ioFs,
  });
  if (!opened.ok) {
    return opened;
  }
  return {
    ok: true,
    path: opened.path,
    fd: opened.fd,
    stat: opened.stat,
    rootRealPath,
  };
}

export async function openBoundaryFile(
  params: OpenBoundaryFileParams,
): Promise<BoundaryFileOpenResult> {
  try {
    await assertNoPathAliasEscape({
      absolutePath: params.absolutePath,
      rootPath: params.rootPath,
      boundaryLabel: params.boundaryLabel,
      policy: params.aliasPolicy,
    });
  } catch (error) {
    return { ok: false, reason: "validation", error };
  }
  return openBoundaryFileSync(params);
}
