import fs from "node:fs";
import path from "node:path";
import {
  resolveBoundaryPath,
  resolveBoundaryPathSync,
  type ResolvedBoundaryPath,
} from "./boundary-path.js";
import type { PathAliasPolicy } from "./path-alias-guards.js";
import {
  openVerifiedFileSync,
  type SafeOpenSyncAllowedType,
  type SafeOpenSyncFailureReason,
} from "./safe-open-sync.js";

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

export type BoundaryFileOpenFailure = Extract<BoundaryFileOpenResult, { ok: false }>;

export type OpenBoundaryFileSyncParams = {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  rootRealPath?: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: SafeOpenSyncAllowedType;
  skipLexicalRootCheck?: boolean;
  ioFs?: BoundaryReadFs;
};

export type OpenBoundaryFileParams = OpenBoundaryFileSyncParams & {
  aliasPolicy?: PathAliasPolicy;
};

type ResolvedBoundaryFilePath = {
  absolutePath: string;
  resolvedPath: string;
  rootRealPath: string;
};

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
  const resolved = resolveBoundaryFilePathGeneric({
    absolutePath: params.absolutePath,
    resolve: (absolutePath) =>
      resolveBoundaryPathSync({
        absolutePath,
        rootPath: params.rootPath,
        rootCanonicalPath: params.rootRealPath,
        boundaryLabel: params.boundaryLabel,
        skipLexicalRootCheck: params.skipLexicalRootCheck,
      }),
  });
  if (resolved instanceof Promise) {
    return toBoundaryValidationError(new Error("Unexpected async boundary resolution"));
  }
  return finalizeBoundaryFileOpen({
    resolved,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    allowedType: params.allowedType,
    ioFs,
  });
}

export function matchBoundaryFileOpenFailure<T>(
  failure: BoundaryFileOpenFailure,
  handlers: {
    path?: (failure: BoundaryFileOpenFailure) => T;
    validation?: (failure: BoundaryFileOpenFailure) => T;
    io?: (failure: BoundaryFileOpenFailure) => T;
    fallback: (failure: BoundaryFileOpenFailure) => T;
  },
): T {
  switch (failure.reason) {
    case "path":
      return handlers.path ? handlers.path(failure) : handlers.fallback(failure);
    case "validation":
      return handlers.validation ? handlers.validation(failure) : handlers.fallback(failure);
    case "io":
      return handlers.io ? handlers.io(failure) : handlers.fallback(failure);
  }
  return handlers.fallback(failure);
}

function openBoundaryFileResolved(params: {
  absolutePath: string;
  resolvedPath: string;
  rootRealPath: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: SafeOpenSyncAllowedType;
  ioFs: BoundaryReadFs;
}): BoundaryFileOpenResult {
  const opened = openVerifiedFileSync({
    filePath: params.absolutePath,
    resolvedPath: params.resolvedPath,
    rejectHardlinks: params.rejectHardlinks ?? true,
    maxBytes: params.maxBytes,
    allowedType: params.allowedType,
    ioFs: params.ioFs,
  });
  if (!opened.ok) {
    return opened;
  }
  return {
    ok: true,
    path: opened.path,
    fd: opened.fd,
    stat: opened.stat,
    rootRealPath: params.rootRealPath,
  };
}

function finalizeBoundaryFileOpen(params: {
  resolved: ResolvedBoundaryFilePath | BoundaryFileOpenResult;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: SafeOpenSyncAllowedType;
  ioFs: BoundaryReadFs;
}): BoundaryFileOpenResult {
  if ("ok" in params.resolved) {
    return params.resolved;
  }
  return openBoundaryFileResolved({
    absolutePath: params.resolved.absolutePath,
    resolvedPath: params.resolved.resolvedPath,
    rootRealPath: params.resolved.rootRealPath,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    allowedType: params.allowedType,
    ioFs: params.ioFs,
  });
}

export async function openBoundaryFile(
  params: OpenBoundaryFileParams,
): Promise<BoundaryFileOpenResult> {
  const ioFs = params.ioFs ?? fs;
  const maybeResolved = resolveBoundaryFilePathGeneric({
    absolutePath: params.absolutePath,
    resolve: (absolutePath) =>
      resolveBoundaryPath({
        absolutePath,
        rootPath: params.rootPath,
        rootCanonicalPath: params.rootRealPath,
        boundaryLabel: params.boundaryLabel,
        policy: params.aliasPolicy,
        skipLexicalRootCheck: params.skipLexicalRootCheck,
      }),
  });
  const resolved = maybeResolved instanceof Promise ? await maybeResolved : maybeResolved;
  return finalizeBoundaryFileOpen({
    resolved,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    allowedType: params.allowedType,
    ioFs,
  });
}

function toBoundaryValidationError(error: unknown): BoundaryFileOpenResult {
  return { ok: false, reason: "validation", error };
}

function mapResolvedBoundaryPath(
  absolutePath: string,
  resolved: ResolvedBoundaryPath,
): ResolvedBoundaryFilePath {
  return {
    absolutePath,
    resolvedPath: resolved.canonicalPath,
    rootRealPath: resolved.rootCanonicalPath,
  };
}

function resolveBoundaryFilePathGeneric(params: {
  absolutePath: string;
  resolve: (absolutePath: string) => ResolvedBoundaryPath | Promise<ResolvedBoundaryPath>;
}):
  | ResolvedBoundaryFilePath
  | BoundaryFileOpenResult
  | Promise<ResolvedBoundaryFilePath | BoundaryFileOpenResult> {
  const absolutePath = path.resolve(params.absolutePath);
  try {
    const resolved = params.resolve(absolutePath);
    if (resolved instanceof Promise) {
      return resolved
        .then((value) => mapResolvedBoundaryPath(absolutePath, value))
        .catch((error) => toBoundaryValidationError(error));
    }
    return mapResolvedBoundaryPath(absolutePath, resolved);
  } catch (error) {
    return toBoundaryValidationError(error);
  }
}
