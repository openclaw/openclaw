import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isNotFoundPathError, isPathInside } from "./path-guards.js";

export type BoundaryPathIntent = "read" | "write" | "create" | "delete" | "stat";

export type BoundaryPathAliasPolicy = {
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
};

export const BOUNDARY_PATH_ALIAS_POLICIES = {
  strict: Object.freeze({
    allowFinalSymlinkForUnlink: false,
    allowFinalHardlinkForUnlink: false,
  }),
  unlinkTarget: Object.freeze({
    allowFinalSymlinkForUnlink: true,
    allowFinalHardlinkForUnlink: true,
  }),
} as const;

export type ResolveBoundaryPathParams = {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  intent?: BoundaryPathIntent;
  policy?: BoundaryPathAliasPolicy;
  skipLexicalRootCheck?: boolean;
  rootCanonicalPath?: string;
};

export type ResolvedBoundaryPathKind = "missing" | "file" | "directory" | "symlink" | "other";

export type ResolvedBoundaryPath = {
  absolutePath: string;
  canonicalPath: string;
  rootPath: string;
  rootCanonicalPath: string;
  relativePath: string;
  exists: boolean;
  kind: ResolvedBoundaryPathKind;
};

export async function resolveBoundaryPath(
  params: ResolveBoundaryPathParams,
): Promise<ResolvedBoundaryPath> {
  const rootPath = path.resolve(params.rootPath);
  const absolutePath = path.resolve(params.absolutePath);
  const rootCanonicalPath = params.rootCanonicalPath
    ? path.resolve(params.rootCanonicalPath)
    : await resolvePathViaExistingAncestor(rootPath);
  const lexicalInside = isPathInside(rootPath, absolutePath);
  const outsideLexicalCanonicalPath = lexicalInside
    ? undefined
    : await resolvePathViaExistingAncestor(absolutePath);
  const canonicalOutsideLexicalPath = resolveCanonicalOutsideLexicalPath({
    absolutePath,
    outsideLexicalCanonicalPath,
  });
  assertLexicalBoundaryOrCanonicalAlias({
    skipLexicalRootCheck: params.skipLexicalRootCheck,
    lexicalInside,
    canonicalOutsideLexicalPath,
    rootCanonicalPath,
    boundaryLabel: params.boundaryLabel,
    rootPath,
    absolutePath,
  });

  if (!lexicalInside) {
    const canonicalPath = canonicalOutsideLexicalPath;
    assertInsideBoundary({
      boundaryLabel: params.boundaryLabel,
      rootCanonicalPath,
      candidatePath: canonicalPath,
      absolutePath,
    });
    const kind = await getPathKind(absolutePath, false);
    return buildResolvedBoundaryPath({
      absolutePath,
      canonicalPath,
      rootPath,
      rootCanonicalPath,
      kind,
    });
  }

  return resolveBoundaryPathLexicalAsync({
    params,
    absolutePath,
    rootPath,
    rootCanonicalPath,
  });
}

export function resolveBoundaryPathSync(params: ResolveBoundaryPathParams): ResolvedBoundaryPath {
  const rootPath = path.resolve(params.rootPath);
  const absolutePath = path.resolve(params.absolutePath);
  const rootCanonicalPath = params.rootCanonicalPath
    ? path.resolve(params.rootCanonicalPath)
    : resolvePathViaExistingAncestorSync(rootPath);
  const lexicalInside = isPathInside(rootPath, absolutePath);
  const outsideLexicalCanonicalPath = lexicalInside
    ? undefined
    : resolvePathViaExistingAncestorSync(absolutePath);
  const canonicalOutsideLexicalPath = resolveCanonicalOutsideLexicalPath({
    absolutePath,
    outsideLexicalCanonicalPath,
  });
  assertLexicalBoundaryOrCanonicalAlias({
    skipLexicalRootCheck: params.skipLexicalRootCheck,
    lexicalInside,
    canonicalOutsideLexicalPath,
    rootCanonicalPath,
    boundaryLabel: params.boundaryLabel,
    rootPath,
    absolutePath,
  });

  if (!lexicalInside) {
    const canonicalPath = canonicalOutsideLexicalPath;
    assertInsideBoundary({
      boundaryLabel: params.boundaryLabel,
      rootCanonicalPath,
      candidatePath: canonicalPath,
      absolutePath,
    });
    const kind = getPathKindSync(absolutePath, false);
    return buildResolvedBoundaryPath({
      absolutePath,
      canonicalPath,
      rootPath,
      rootCanonicalPath,
      kind,
    });
  }

  return resolveBoundaryPathLexicalSync({
    params,
    absolutePath,
    rootPath,
    rootCanonicalPath,
  });
}

async function resolveBoundaryPathLexicalAsync(params: {
  params: ResolveBoundaryPathParams;
  absolutePath: string;
  rootPath: string;
  rootCanonicalPath: string;
}): Promise<ResolvedBoundaryPath> {
  const relative = path.relative(params.rootPath, params.absolutePath);
  const segments = relative.split(path.sep).filter(Boolean);
  const allowFinalSymlink = params.params.policy?.allowFinalSymlinkForUnlink === true;
  let canonicalCursor = params.rootCanonicalPath;
  let lexicalCursor = params.rootPath;
  let preserveFinalSymlink = false;

  for (let idx = 0; idx < segments.length; idx += 1) {
    const segment = segments[idx] ?? "";
    const isLast = idx === segments.length - 1;
    lexicalCursor = path.join(lexicalCursor, segment);

    let stat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      stat = await fsp.lstat(lexicalCursor);
    } catch (error) {
      if (isNotFoundPathError(error)) {
        const missingSuffix = segments.slice(idx);
        canonicalCursor = path.resolve(canonicalCursor, ...missingSuffix);
        assertInsideBoundary({
          boundaryLabel: params.params.boundaryLabel,
          rootCanonicalPath: params.rootCanonicalPath,
          candidatePath: canonicalCursor,
          absolutePath: params.absolutePath,
        });
        break;
      }
      throw error;
    }

    if (!stat.isSymbolicLink()) {
      canonicalCursor = path.resolve(canonicalCursor, segment);
      assertInsideBoundary({
        boundaryLabel: params.params.boundaryLabel,
        rootCanonicalPath: params.rootCanonicalPath,
        candidatePath: canonicalCursor,
        absolutePath: params.absolutePath,
      });
      continue;
    }

    if (allowFinalSymlink && isLast) {
      preserveFinalSymlink = true;
      canonicalCursor = path.resolve(canonicalCursor, segment);
      assertInsideBoundary({
        boundaryLabel: params.params.boundaryLabel,
        rootCanonicalPath: params.rootCanonicalPath,
        candidatePath: canonicalCursor,
        absolutePath: params.absolutePath,
      });
      break;
    }

    const linkCanonical = await resolveSymlinkHopPath(lexicalCursor);
    if (!isPathInside(params.rootCanonicalPath, linkCanonical)) {
      throw symlinkEscapeError({
        boundaryLabel: params.params.boundaryLabel,
        rootCanonicalPath: params.rootCanonicalPath,
        symlinkPath: lexicalCursor,
      });
    }
    canonicalCursor = linkCanonical;
    lexicalCursor = linkCanonical;
  }

  assertInsideBoundary({
    boundaryLabel: params.params.boundaryLabel,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: canonicalCursor,
    absolutePath: params.absolutePath,
  });
  const kind = await getPathKind(params.absolutePath, preserveFinalSymlink);
  return buildResolvedBoundaryPath({
    absolutePath: params.absolutePath,
    canonicalPath: canonicalCursor,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    kind,
  });
}

function resolveBoundaryPathLexicalSync(params: {
  params: ResolveBoundaryPathParams;
  absolutePath: string;
  rootPath: string;
  rootCanonicalPath: string;
}): ResolvedBoundaryPath {
  const relative = path.relative(params.rootPath, params.absolutePath);
  const segments = relative.split(path.sep).filter(Boolean);
  const allowFinalSymlink = params.params.policy?.allowFinalSymlinkForUnlink === true;
  let canonicalCursor = params.rootCanonicalPath;
  let lexicalCursor = params.rootPath;
  let preserveFinalSymlink = false;

  for (let idx = 0; idx < segments.length; idx += 1) {
    const segment = segments[idx] ?? "";
    const isLast = idx === segments.length - 1;
    lexicalCursor = path.join(lexicalCursor, segment);

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(lexicalCursor);
    } catch (error) {
      if (isNotFoundPathError(error)) {
        const missingSuffix = segments.slice(idx);
        canonicalCursor = path.resolve(canonicalCursor, ...missingSuffix);
        assertInsideBoundary({
          boundaryLabel: params.params.boundaryLabel,
          rootCanonicalPath: params.rootCanonicalPath,
          candidatePath: canonicalCursor,
          absolutePath: params.absolutePath,
        });
        break;
      }
      throw error;
    }

    if (!stat.isSymbolicLink()) {
      canonicalCursor = path.resolve(canonicalCursor, segment);
      assertInsideBoundary({
        boundaryLabel: params.params.boundaryLabel,
        rootCanonicalPath: params.rootCanonicalPath,
        candidatePath: canonicalCursor,
        absolutePath: params.absolutePath,
      });
      continue;
    }

    if (allowFinalSymlink && isLast) {
      preserveFinalSymlink = true;
      canonicalCursor = path.resolve(canonicalCursor, segment);
      assertInsideBoundary({
        boundaryLabel: params.params.boundaryLabel,
        rootCanonicalPath: params.rootCanonicalPath,
        candidatePath: canonicalCursor,
        absolutePath: params.absolutePath,
      });
      break;
    }

    const linkCanonical = resolveSymlinkHopPathSync(lexicalCursor);
    if (!isPathInside(params.rootCanonicalPath, linkCanonical)) {
      throw symlinkEscapeError({
        boundaryLabel: params.params.boundaryLabel,
        rootCanonicalPath: params.rootCanonicalPath,
        symlinkPath: lexicalCursor,
      });
    }
    canonicalCursor = linkCanonical;
    lexicalCursor = linkCanonical;
  }

  assertInsideBoundary({
    boundaryLabel: params.params.boundaryLabel,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: canonicalCursor,
    absolutePath: params.absolutePath,
  });
  const kind = getPathKindSync(params.absolutePath, preserveFinalSymlink);
  return buildResolvedBoundaryPath({
    absolutePath: params.absolutePath,
    canonicalPath: canonicalCursor,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    kind,
  });
}

function resolveCanonicalOutsideLexicalPath(params: {
  absolutePath: string;
  outsideLexicalCanonicalPath?: string;
}): string {
  return params.outsideLexicalCanonicalPath ?? params.absolutePath;
}

function assertLexicalBoundaryOrCanonicalAlias(params: {
  skipLexicalRootCheck?: boolean;
  lexicalInside: boolean;
  canonicalOutsideLexicalPath: string;
  rootCanonicalPath: string;
  boundaryLabel: string;
  rootPath: string;
  absolutePath: string;
}): void {
  if (params.skipLexicalRootCheck || params.lexicalInside) {
    return;
  }
  if (isPathInside(params.rootCanonicalPath, params.canonicalOutsideLexicalPath)) {
    return;
  }
  throw pathEscapeError({
    boundaryLabel: params.boundaryLabel,
    rootPath: params.rootPath,
    absolutePath: params.absolutePath,
  });
}

function buildResolvedBoundaryPath(params: {
  absolutePath: string;
  canonicalPath: string;
  rootPath: string;
  rootCanonicalPath: string;
  kind: { exists: boolean; kind: ResolvedBoundaryPathKind };
}): ResolvedBoundaryPath {
  return {
    absolutePath: params.absolutePath,
    canonicalPath: params.canonicalPath,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    relativePath: relativeInsideRoot(params.rootCanonicalPath, params.canonicalPath),
    exists: params.kind.exists,
    kind: params.kind.kind,
  };
}

export async function resolvePathViaExistingAncestor(targetPath: string): Promise<string> {
  const normalized = path.resolve(targetPath);
  let cursor = normalized;
  const missingSuffix: string[] = [];

  while (!isFilesystemRoot(cursor) && !(await pathExists(cursor))) {
    missingSuffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  if (!(await pathExists(cursor))) {
    return normalized;
  }

  try {
    const resolvedAncestor = path.resolve(await fsp.realpath(cursor));
    if (missingSuffix.length === 0) {
      return resolvedAncestor;
    }
    return path.resolve(resolvedAncestor, ...missingSuffix);
  } catch {
    return normalized;
  }
}

export function resolvePathViaExistingAncestorSync(targetPath: string): string {
  const normalized = path.resolve(targetPath);
  let cursor = normalized;
  const missingSuffix: string[] = [];

  while (!isFilesystemRoot(cursor) && !fs.existsSync(cursor)) {
    missingSuffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  if (!fs.existsSync(cursor)) {
    return normalized;
  }

  try {
    // Keep sync behavior aligned with async (`fsp.realpath`) to avoid
    // platform-specific canonical alias drift (notably on Windows).
    const resolvedAncestor = path.resolve(fs.realpathSync(cursor));
    if (missingSuffix.length === 0) {
      return resolvedAncestor;
    }
    return path.resolve(resolvedAncestor, ...missingSuffix);
  } catch {
    return normalized;
  }
}

async function getPathKind(
  absolutePath: string,
  preserveFinalSymlink: boolean,
): Promise<{ exists: boolean; kind: ResolvedBoundaryPathKind }> {
  try {
    const stat = preserveFinalSymlink
      ? await fsp.lstat(absolutePath)
      : await fsp.stat(absolutePath);
    return { exists: true, kind: toResolvedKind(stat) };
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return { exists: false, kind: "missing" };
    }
    throw error;
  }
}

function getPathKindSync(
  absolutePath: string,
  preserveFinalSymlink: boolean,
): { exists: boolean; kind: ResolvedBoundaryPathKind } {
  try {
    const stat = preserveFinalSymlink ? fs.lstatSync(absolutePath) : fs.statSync(absolutePath);
    return { exists: true, kind: toResolvedKind(stat) };
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return { exists: false, kind: "missing" };
    }
    throw error;
  }
}

function toResolvedKind(stat: fs.Stats): ResolvedBoundaryPathKind {
  if (stat.isFile()) {
    return "file";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  if (stat.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
}

function relativeInsideRoot(rootPath: string, targetPath: string): string {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (!relative || relative === ".") {
    return "";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "";
  }
  return relative;
}

function assertInsideBoundary(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  candidatePath: string;
  absolutePath: string;
}): void {
  if (isPathInside(params.rootCanonicalPath, params.candidatePath)) {
    return;
  }
  throw new Error(
    `Path resolves outside ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.absolutePath)}`,
  );
}

function pathEscapeError(params: {
  boundaryLabel: string;
  rootPath: string;
  absolutePath: string;
}): Error {
  return new Error(
    `Path escapes ${params.boundaryLabel} (${shortPath(params.rootPath)}): ${shortPath(params.absolutePath)}`,
  );
}

function symlinkEscapeError(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  symlinkPath: string;
}): Error {
  return new Error(
    `Symlink escapes ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.symlinkPath)}`,
  );
}

function shortPath(value: string): string {
  const home = os.homedir();
  if (value.startsWith(home)) {
    return `~${value.slice(home.length)}`;
  }
  return value;
}

function isFilesystemRoot(candidate: string): boolean {
  return path.parse(candidate).root === candidate;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.lstat(targetPath);
    return true;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function resolveSymlinkHopPath(symlinkPath: string): Promise<string> {
  try {
    return path.resolve(await fsp.realpath(symlinkPath));
  } catch (error) {
    if (!isNotFoundPathError(error)) {
      throw error;
    }
    const linkTarget = await fsp.readlink(symlinkPath);
    const linkAbsolute = path.resolve(path.dirname(symlinkPath), linkTarget);
    return resolvePathViaExistingAncestor(linkAbsolute);
  }
}

function resolveSymlinkHopPathSync(symlinkPath: string): string {
  try {
    return path.resolve(fs.realpathSync(symlinkPath));
  } catch (error) {
    if (!isNotFoundPathError(error)) {
      throw error;
    }
    const linkTarget = fs.readlinkSync(symlinkPath);
    const linkAbsolute = path.resolve(path.dirname(symlinkPath), linkTarget);
    return resolvePathViaExistingAncestorSync(linkAbsolute);
  }
}
