import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { root as openFsRoot } from "./fs-safe.js";
import type { PackageDistContentInventoryEntry } from "./package-dist-inventory.js";

export type LocalOverridePackageRoot = Awaited<ReturnType<typeof openFsRoot>>;

export type LocalPackageOverrideKind = "added" | "modified" | "deleted";
export type LocalPackageOverrideConflictReason =
  | "target-changed"
  | "target-exists"
  | "target-missing"
  | "target-hardlinked"
  | "target-inspection-failed"
  | "apply-failed"
  | "rollback-failed";

export type LocalPackageOverrideChange = {
  kind: LocalPackageOverrideKind;
  path: string;
  baseline?: PackageDistContentInventoryEntry;
  dependencies?: string[];
  reapply?: boolean;
  savedPath?: string;
  mode?: number;
};

export type LocalPackageOverridesResult = {
  status: "none" | "preserved" | "applied" | "conflict" | "error";
  added: number;
  modified: number;
  deleted: number;
  applied: number;
  conflicts: Array<{
    path: string;
    reason: LocalPackageOverrideConflictReason;
  }>;
  recoveryDir?: string;
  warnings: string[];
};

export type LocalPackageOverridesPlan = {
  packageRoot: string;
  recoveryDir: string;
  changes: LocalPackageOverrideChange[];
  result: LocalPackageOverridesResult;
};

export function emptyResult(
  status: LocalPackageOverridesResult["status"],
): LocalPackageOverridesResult {
  return {
    status,
    added: 0,
    modified: 0,
    deleted: 0,
    applied: 0,
    conflicts: [],
    warnings: [],
  };
}

export async function packageRootExists(packageRoot: string): Promise<boolean> {
  try {
    await fs.lstat(packageRoot);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export type LocalOverridePackageRootIdentity = {
  realPath: string;
  device: bigint;
  inode: bigint;
};

export async function readLocalOverridePackageRootIdentity(
  packageRoot: string,
): Promise<LocalOverridePackageRootIdentity> {
  const realPath = await fs.realpath(packageRoot);
  const stats = await fs.stat(realPath, { bigint: true });
  if (!stats.isDirectory()) {
    throw new Error(`local override package root is not a directory: ${packageRoot}`);
  }
  return { realPath, device: stats.dev, inode: stats.ino };
}

export function isSameLocalOverridePackageRoot(
  left: LocalOverridePackageRootIdentity,
  right: LocalOverridePackageRootIdentity,
): boolean {
  return (
    left.realPath === right.realPath && left.device === right.device && left.inode === right.inode
  );
}

export function isMissingPathError(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "not-found"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export type LocalPackageOverrideTargetProbe =
  | { status: "missing" }
  | { status: "blocked" }
  | { status: "error" }
  | {
      status: "present";
      hardlinked: boolean;
      mode: number;
      safeFile: boolean;
    };

export async function probeLocalOverrideTarget(
  targetPath: string,
): Promise<LocalPackageOverrideTargetProbe> {
  try {
    const stats = await fs.lstat(targetPath, { bigint: true });
    return {
      status: "present",
      hardlinked: stats.nlink > 1n,
      mode: Number(stats.mode & 0o777n),
      safeFile: stats.isFile() && !stats.isSymbolicLink(),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "missing" };
    }
    if (code === "ENOTDIR") {
      return { status: "blocked" };
    }
    return { status: "error" };
  }
}

export async function resolveLocalOverrideTopologyPath(
  packageRoot: string,
  realPackageRoot: string,
  relativePath: string,
): Promise<string> {
  const segments = normalizeDistPath(relativePath).split("/");
  for (
    let existingSegmentCount = segments.length;
    existingSegmentCount >= 0;
    existingSegmentCount--
  ) {
    const existingPath = path.join(packageRoot, ...segments.slice(0, existingSegmentCount));
    try {
      const realExistingPath = await fs.realpath(existingPath);
      const resolvedTopologyPath = path.resolve(
        realExistingPath,
        ...segments.slice(existingSegmentCount),
      );
      if (
        resolvedTopologyPath === realPackageRoot ||
        resolvedTopologyPath.startsWith(`${realPackageRoot}${path.sep}`)
      ) {
        return resolvedTopologyPath;
      }
      throw new Error(`local override topology escapes package root: ${relativePath}`);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }
  throw new Error(`could not resolve local override topology for ${relativePath}`);
}

export async function resolvePathTopology(targetPath: string): Promise<string> {
  const missingSegments: string[] = [];
  let currentPath = path.resolve(targetPath);
  while (true) {
    try {
      return path.resolve(await fs.realpath(currentPath), ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        throw error;
      }
      missingSegments.unshift(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
}

export async function assertRecoveryRootOutsidePackageRoot(
  packageRoot: string,
  recoveryRoot: string,
): Promise<void> {
  const [resolvedPackageRoot, resolvedRecoveryRoot] = await Promise.all([
    resolvePathTopology(packageRoot),
    resolvePathTopology(recoveryRoot),
  ]);
  if (
    resolvedRecoveryRoot === resolvedPackageRoot ||
    resolvedRecoveryRoot.startsWith(`${resolvedPackageRoot}${path.sep}`)
  ) {
    throw new Error(`local override recovery root must be outside package root: ${recoveryRoot}`);
  }
}

export function countChanges(changes: LocalPackageOverrideChange[]) {
  return {
    added: changes.filter((change) => change.kind === "added").length,
    modified: changes.filter((change) => change.kind === "modified").length,
    deleted: changes.filter((change) => change.kind === "deleted").length,
  };
}

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

export function normalizeDistPath(relativePath: string): string {
  return normalizeRelativePath(path.posix.normalize(relativePath));
}

export function resolveSafePackagePath(packageRoot: string, relativePath: string): string {
  const normalized = normalizeDistPath(relativePath);
  if (!normalized.startsWith("dist/") || normalized.includes("\0")) {
    throw new Error(`unsafe local override path: ${relativePath}`);
  }
  const resolved = path.resolve(packageRoot, normalized);
  const root = path.resolve(packageRoot);
  if (resolved !== root && resolved.startsWith(`${root}${path.sep}`)) {
    return resolved;
  }
  throw new Error(`local override path escapes package root: ${relativePath}`);
}

export async function assertLocalOverrideMutationTopology(params: {
  packageRoot: string;
  realPackageRoot: string;
  relativePath: string;
}): Promise<void> {
  const resolvedPath = await resolveLocalOverrideTopologyPath(
    params.packageRoot,
    params.realPackageRoot,
    params.relativePath,
  );
  const expectedPath = path.resolve(params.realPackageRoot, normalizeDistPath(params.relativePath));
  if (resolvedPath !== expectedPath) {
    throw new Error(`local override topology changed: ${params.relativePath}`);
  }
}

export async function inspectLocalOverrideTarget(params: {
  packageFs: LocalOverridePackageRoot;
  relativePath: string;
  expectedSize: number;
}): Promise<{ mode: number; sha256: string }> {
  const target = await params.packageFs.read(params.relativePath, {
    hardlinks: "reject",
    maxBytes: params.expectedSize,
    nonBlockingRead: true,
    symlinks: "reject",
  });
  return {
    mode: normalizeFileMode(target.stat.mode),
    sha256: createHash("sha256").update(target.buffer).digest("hex"),
  };
}

export async function buildLocalOverrideInventoryEntry(params: {
  relativePath: string;
  sourcePath: string;
  mode?: number;
}): Promise<PackageDistContentInventoryEntry> {
  const content = await fs.readFile(params.sourcePath);
  const stats = await fs.stat(params.sourcePath);
  return {
    path: params.relativePath,
    sha256: createHash("sha256").update(content).digest("hex"),
    mode: params.mode ?? normalizeFileMode(stats.mode),
    size: content.length,
  };
}

export function normalizeFileMode(mode: number): number {
  return mode & 0o777;
}

export function fileModesHaveSameExecutableSemantics(left: number, right: number): boolean {
  return (
    process.platform === "win32" ||
    (normalizeFileMode(left) & 0o111) === (normalizeFileMode(right) & 0o111)
  );
}

export function mergeLocalOverrideFileMode(targetMode: number, overrideMode: number): number {
  return (normalizeFileMode(targetMode) & ~0o111) | (normalizeFileMode(overrideMode) & 0o111);
}

export async function writeFileWithMode(
  content: Buffer,
  destination: string,
  mode?: number,
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
  if (mode !== undefined && process.platform !== "win32") {
    await fs.chmod(destination, mode);
  }
}
