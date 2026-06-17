import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getFsSafePythonConfig } from "@openclaw/fs-safe/config";
import { resolveStateDir } from "../config/paths.js";
import { formatErrorMessage } from "./errors.js";
import { FsSafeError, root as openFsRoot } from "./fs-safe.js";
import {
  collectPackageDistInventory,
  isLegacyContentInventoryCompatVersion,
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  readPackageDistContentInventoryIfPresent,
  type PackageDistContentInventoryEntry,
} from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";

type LocalPackageOverrideKind = "added" | "modified" | "deleted";
type LocalPackageOverrideConflictReason =
  | "target-changed"
  | "target-exists"
  | "target-missing"
  | "target-hardlinked"
  | "target-inspection-failed"
  | "apply-failed"
  | "rollback-failed";

type LocalPackageOverrideChange = {
  kind: LocalPackageOverrideKind;
  path: string;
  baseline?: PackageDistContentInventoryEntry;
  dependencies?: string[];
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

function emptyResult(status: LocalPackageOverridesResult["status"]): LocalPackageOverridesResult {
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

async function packageRootExists(packageRoot: string): Promise<boolean> {
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

type LocalOverridePackageRootIdentity = {
  realPath: string;
  device: bigint;
  inode: bigint;
};

async function readLocalOverridePackageRootIdentity(
  packageRoot: string,
): Promise<LocalOverridePackageRootIdentity> {
  const realPath = await fs.realpath(packageRoot);
  const stats = await fs.stat(realPath, { bigint: true });
  if (!stats.isDirectory()) {
    throw new Error(`local override package root is not a directory: ${packageRoot}`);
  }
  return { realPath, device: stats.dev, inode: stats.ino };
}

function isSameLocalOverridePackageRoot(
  left: LocalOverridePackageRootIdentity,
  right: LocalOverridePackageRootIdentity,
): boolean {
  return (
    left.realPath === right.realPath && left.device === right.device && left.inode === right.inode
  );
}

function isMissingPathError(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "not-found"].includes((error as NodeJS.ErrnoException).code ?? "");
}

type LocalPackageOverrideTargetProbe =
  | { status: "missing" }
  | { status: "blocked" }
  | { status: "error" }
  | {
      status: "present";
      hardlinked: boolean;
      mode: number;
      safeFile: boolean;
    };

async function probeLocalOverrideTarget(
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

async function resolveLocalOverrideTopologyPath(
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

async function resolvePathTopology(targetPath: string): Promise<string> {
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

async function assertRecoveryRootOutsidePackageRoot(
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

function countChanges(changes: LocalPackageOverrideChange[]) {
  return {
    added: changes.filter((change) => change.kind === "added").length,
    modified: changes.filter((change) => change.kind === "modified").length,
    deleted: changes.filter((change) => change.kind === "deleted").length,
  };
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function normalizeDistPath(relativePath: string): string {
  return normalizeRelativePath(path.posix.normalize(relativePath));
}

function resolveSafePackagePath(packageRoot: string, relativePath: string): string {
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

async function assertLocalOverrideMutationTopology(params: {
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

async function inspectLocalOverrideTarget(params: {
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

async function buildLocalOverrideInventoryEntry(params: {
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

function normalizeFileMode(mode: number): number {
  return mode & 0o777;
}

function fileModesHaveSameExecutableSemantics(left: number, right: number): boolean {
  return (
    process.platform === "win32" ||
    (normalizeFileMode(left) & 0o111) === (normalizeFileMode(right) & 0o111)
  );
}

function mergeLocalOverrideFileMode(targetMode: number, overrideMode: number): number {
  return (normalizeFileMode(targetMode) & ~0o111) | (normalizeFileMode(overrideMode) & 0o111);
}

async function writeFileWithMode(
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

type LocalOverridePackageRoot = Awaited<ReturnType<typeof openFsRoot>>;
const execFileAsync = promisify(execFile);
// fs-safe's helper mode is process-global, so fail-closed replay operations run
// in an isolated process instead of changing the parent configuration.
const REQUIRED_FS_SAFE_OPERATION_SCRIPT = `
const [configUrl, rootUrl, operation, rootDir, sourcePath, relativePath, pythonPath] =
  process.argv.slice(1);
const { configureFsSafePython } = await import(configUrl);
configureFsSafePython({ mode: "require", ...(pythonPath ? { pythonPath } : {}) });
const { root } = await import(rootUrl);
const packageFs = await root(rootDir, { hardlinks: "reject", symlinks: "reject" });
if (operation === "stat") {
  await packageFs.stat(".");
} else if (operation === "move") {
  await packageFs.move(sourcePath, relativePath, { overwrite: false });
} else {
  throw new Error("unsupported required fs-safe operation");
}
`;

async function runRequiredFsSafePythonOperation(
  params:
    | { operation: "stat"; packageFs: LocalOverridePackageRoot }
    | {
        operation: "move";
        packageFs: LocalOverridePackageRoot;
        sourcePath: string;
        relativePath: string;
      },
): Promise<void> {
  const pythonPath = getFsSafePythonConfig().pythonPath ?? "";
  const sourcePath = params.operation === "move" ? params.sourcePath : "";
  const relativePath = params.operation === "move" ? params.relativePath : "";
  await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      REQUIRED_FS_SAFE_OPERATION_SCRIPT,
      import.meta.resolve("@openclaw/fs-safe/config"),
      import.meta.resolve("@openclaw/fs-safe/root"),
      params.operation,
      params.packageFs.rootReal,
      sourcePath,
      relativePath,
      pythonPath,
    ],
    { timeout: 30_000, windowsHide: true },
  );
}

class LocalOverrideRollbackError extends Error {
  constructor(
    readonly relativePath: string,
    readonly action: string,
    readonly rollbackError: unknown,
  ) {
    super(
      `local override rollback failed for ${relativePath}: ${formatErrorMessage(rollbackError)}`,
    );
    this.name = "LocalOverrideRollbackError";
  }
}

function createLocalOverrideMutationPath(relativePath: string, label: string): string {
  const normalized = normalizeDistPath(relativePath);
  return path.posix.join(
    path.posix.dirname(normalized),
    `.openclaw-override-${label}-${randomUUID()}.tmp`,
  );
}

async function moveLocalOverrideTargetNoReplace(params: {
  packageFs: LocalOverridePackageRoot;
  sourcePath: string;
  relativePath: string;
}): Promise<void> {
  if (process.platform === "win32") {
    await params.packageFs.move(params.sourcePath, params.relativePath, { overwrite: false });
    return;
  }
  // Executable override replay fails closed instead of using fs-safe's path-based
  // Node fallback for the final no-clobber publish.
  await runRequiredFsSafePythonOperation({ operation: "move", ...params });
}

async function writeRollbackBackup(params: {
  backupPath: string;
  content: Buffer;
  mode: number;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.backupPath), { recursive: true });
  await fs.writeFile(params.backupPath, params.content);
  if (process.platform !== "win32") {
    await fs.chmod(params.backupPath, params.mode);
  }
}

async function publishLocalOverrideTarget(params: {
  packageFs: LocalOverridePackageRoot;
  sourcePath: string;
  relativePath: string;
  onPublished?: () => void;
}): Promise<void> {
  await assertLocalOverrideMutationTopology({
    packageRoot: params.packageFs.rootDir,
    realPackageRoot: params.packageFs.rootReal,
    relativePath: params.sourcePath,
  });
  await assertLocalOverrideMutationTopology({
    packageRoot: params.packageFs.rootDir,
    realPackageRoot: params.packageFs.rootReal,
    relativePath: params.relativePath,
  });
  await moveLocalOverrideTargetNoReplace(params);
  params.onPublished?.();
  await assertLocalOverrideMutationTopology({
    packageRoot: params.packageFs.rootDir,
    realPackageRoot: params.packageFs.rootReal,
    relativePath: params.relativePath,
  });
}

async function restoreMovedLocalOverrideTarget(params: {
  packageFs: LocalOverridePackageRoot;
  movedPath: string;
  relativePath: string;
}): Promise<void> {
  await publishLocalOverrideTarget({
    packageFs: params.packageFs,
    sourcePath: params.movedPath,
    relativePath: params.relativePath,
  });
}

async function throwAfterRestoringMovedLocalOverrideTarget(params: {
  packageFs: LocalOverridePackageRoot;
  movedPath: string;
  relativePath: string;
  originalError: unknown;
  removeMovedAfterFailedRestore: boolean;
}): Promise<never> {
  try {
    await restoreMovedLocalOverrideTarget({
      packageFs: params.packageFs,
      movedPath: params.movedPath,
      relativePath: params.relativePath,
    });
  } catch (rollbackError) {
    if (params.removeMovedAfterFailedRestore) {
      await params.packageFs.remove(params.movedPath).catch(() => undefined);
    }
    throw new LocalOverrideRollbackError(
      params.relativePath,
      "restore current target",
      rollbackError,
    );
  }
  throw params.originalError;
}

async function removeLocalOverrideCleanupPath(
  packageFs: LocalOverridePackageRoot,
  relativePath: string,
): Promise<void> {
  try {
    await packageFs.remove(relativePath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
}

async function moveExpectedLocalOverrideTarget(params: {
  packageFs: LocalOverridePackageRoot;
  relativePath: string;
  expected: PackageDistContentInventoryEntry;
}): Promise<{ movedPath: string; content: Buffer; mode: number }> {
  const movedPath = createLocalOverrideMutationPath(params.relativePath, "previous");
  let targetMoved = false;
  try {
    if (process.platform !== "win32") {
      // Verify the required publish/restore backend before moving the target aside.
      await runRequiredFsSafePythonOperation({ operation: "stat", packageFs: params.packageFs });
    }
    await params.packageFs.move(params.relativePath, movedPath);
    targetMoved = true;
    const moved = await params.packageFs.read(movedPath, {
      hardlinks: "reject",
      maxBytes: Number.POSITIVE_INFINITY,
      symlinks: "reject",
    });
    const mode = normalizeFileMode(moved.stat.mode);
    const sha256 = createHash("sha256").update(moved.buffer).digest("hex");
    if (
      sha256 !== params.expected.sha256 ||
      !fileModesHaveSameExecutableSemantics(mode, params.expected.mode)
    ) {
      throw new Error(`local override target changed during mutation: ${params.relativePath}`);
    }
    return { movedPath, content: moved.buffer, mode };
  } catch (error) {
    if (targetMoved) {
      await throwAfterRestoringMovedLocalOverrideTarget({
        packageFs: params.packageFs,
        movedPath,
        relativePath: params.relativePath,
        originalError: error,
        removeMovedAfterFailedRestore: false,
      });
    }
    throw error;
  }
}

async function replaceLocalOverrideTarget(params: {
  packageFs: LocalOverridePackageRoot;
  relativePath: string;
  sourcePath: string;
  mode?: number;
  expected?: PackageDistContentInventoryEntry;
  backupPath?: string;
  onCommitted?: (cleanupPaths: string[], backupMode?: number) => void;
}): Promise<string[]> {
  const temporaryPath = createLocalOverrideMutationPath(params.relativePath, "next");
  let backupMode: number | undefined;
  let backupWritten = false;
  let committed = false;
  let movedPath: string | undefined;
  let replacementMode = params.mode;
  try {
    await params.packageFs.copyIn(temporaryPath, params.sourcePath, {
      maxBytes: Number.POSITIVE_INFINITY,
      mkdir: true,
      mode: params.mode,
      sourceHardlinks: "reject",
    });
    if (params.expected) {
      if (!params.backupPath) {
        throw new Error(`missing local override rollback path: ${params.relativePath}`);
      }
      const moved = await moveExpectedLocalOverrideTarget({
        packageFs: params.packageFs,
        relativePath: params.relativePath,
        expected: params.expected,
      });
      movedPath = moved.movedPath;
      backupMode = moved.mode;
      if (replacementMode !== undefined) {
        replacementMode = mergeLocalOverrideFileMode(moved.mode, replacementMode);
      }
      await writeRollbackBackup({
        backupPath: params.backupPath,
        content: moved.content,
        mode: moved.mode,
      });
      backupWritten = true;
    }
    if (replacementMode !== undefined && process.platform !== "win32") {
      const temporary = await params.packageFs.open(temporaryPath, {
        hardlinks: "reject",
        symlinks: "reject",
      });
      try {
        await temporary.handle.chmod(replacementMode);
      } finally {
        await temporary.handle.close();
      }
    }
    const cleanupPaths = [temporaryPath, ...(movedPath ? [movedPath] : [])];
    await publishLocalOverrideTarget({
      packageFs: params.packageFs,
      sourcePath: temporaryPath,
      relativePath: params.relativePath,
      onPublished: () => {
        committed = true;
        params.onCommitted?.(cleanupPaths, backupMode);
      },
    });
    return cleanupPaths;
  } catch (error) {
    if (movedPath && !committed) {
      await throwAfterRestoringMovedLocalOverrideTarget({
        packageFs: params.packageFs,
        movedPath,
        relativePath: params.relativePath,
        originalError: error,
        removeMovedAfterFailedRestore: backupWritten,
      });
    }
    throw error;
  } finally {
    if (!committed) {
      await removeLocalOverrideCleanupPath(params.packageFs, temporaryPath).catch(() => undefined);
    }
  }
}

async function deleteLocalOverrideTarget(params: {
  packageFs: LocalOverridePackageRoot;
  relativePath: string;
  expected: PackageDistContentInventoryEntry;
  backupPath: string;
}): Promise<number> {
  const moved = await moveExpectedLocalOverrideTarget({
    packageFs: params.packageFs,
    relativePath: params.relativePath,
    expected: params.expected,
  });
  let backupWritten = false;
  try {
    await writeRollbackBackup({
      backupPath: params.backupPath,
      content: moved.content,
      mode: moved.mode,
    });
    backupWritten = true;
    await params.packageFs.remove(moved.movedPath);
    await assertLocalOverrideMutationTopology({
      packageRoot: params.packageFs.rootDir,
      realPackageRoot: params.packageFs.rootReal,
      relativePath: params.relativePath,
    });
    const targetProbe = await probeLocalOverrideTarget(
      resolveSafePackagePath(params.packageFs.rootReal, params.relativePath),
    );
    if (targetProbe.status !== "missing") {
      throw new Error(`local override deletion target recreated: ${params.relativePath}`);
    }
    return moved.mode;
  } catch (error) {
    return await throwAfterRestoringMovedLocalOverrideTarget({
      packageFs: params.packageFs,
      movedPath: moved.movedPath,
      relativePath: params.relativePath,
      originalError: error,
      removeMovedAfterFailedRestore: backupWritten,
    });
  }
}

async function copyOverridePayload(params: {
  packageFs: LocalOverridePackageRoot;
  recoveryDir: string;
  relativePath: string;
}): Promise<{ savedPath: string; mode: number }> {
  const source = await params.packageFs.read(params.relativePath, {
    hardlinks: "allow",
    maxBytes: Number.POSITIVE_INFINITY,
    symlinks: "reject",
  });
  const mode = normalizeFileMode(source.stat.mode);
  const savedPath = path.join(
    params.recoveryDir,
    "files",
    normalizeRelativePath(params.relativePath),
  );
  await writeFileWithMode(source.buffer, savedPath, mode);
  return { savedPath, mode };
}

const BEST_EFFORT_LOCAL_IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)\b\s*(?:[^'"]*?\bfrom\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/gu;

function resolveReferencedDistPath(params: {
  fromPath: string;
  specifier: string;
  actualSet: Set<string>;
}): string | null {
  const specifierPath = params.specifier.split(/[?#]/u, 1)[0] ?? "";
  if (!specifierPath.startsWith(".")) {
    return null;
  }
  const basePath = normalizeDistPath(
    path.posix.join(path.posix.dirname(params.fromPath), specifierPath),
  );
  const candidates = [
    basePath,
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    `${basePath}.json`,
    path.posix.join(basePath, "index.js"),
  ];
  return candidates.find((candidate) => params.actualSet.has(candidate)) ?? null;
}

async function collectReferencedAddedOverridePaths(params: {
  packageFs: LocalOverridePackageRoot;
  changes: LocalPackageOverrideChange[];
  actualSet: Set<string>;
  baselineSet: Set<string>;
}): Promise<{
  addedPaths: string[];
  dependenciesByChangePath: Map<string, string[]>;
}> {
  const addedPaths = new Set<string>();
  const dependenciesByChangePath = new Map<string, Set<string>>();
  const scannedPathsByRoot = new Set<string>();
  const modifiedChangesByPath = new Map(
    params.changes
      .filter((change) => change.kind === "modified" && change.savedPath)
      .map((change) => [change.path, change]),
  );
  const queue: Array<
    | { path: string; rootPath: string; sourcePath: string }
    | { path: string; rootPath: string; packageRelativePath: string }
  > = [
    ...params.changes
      .filter((change) => change.kind === "modified" && change.savedPath)
      .map((change) => ({
        path: change.path,
        rootPath: change.path,
        sourcePath: change.savedPath as string,
      })),
    ...[...params.actualSet]
      .filter((relativePath) => !params.baselineSet.has(relativePath))
      .map((relativePath) => ({
        path: relativePath,
        rootPath: relativePath,
        packageRelativePath: relativePath,
      })),
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    // Shared added files must be rescanned per override root so partial-conflict
    // reapply keeps each clean importer with its full dependency closure.
    const scanKey = `${current.rootPath}\0${current.path}`;
    if (scannedPathsByRoot.has(scanKey)) {
      continue;
    }
    scannedPathsByRoot.add(scanKey);
    const source =
      "packageRelativePath" in current
        ? await params.packageFs
            .readText(current.packageRelativePath, {
              hardlinks: "allow",
              maxBytes: Number.POSITIVE_INFINITY,
              symlinks: "reject",
            })
            .catch(() => "")
        : await fs.readFile(current.sourcePath, "utf8").catch(() => "");
    for (const match of source.matchAll(BEST_EFFORT_LOCAL_IMPORT_SPECIFIER_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? "";
      const referencedPath = resolveReferencedDistPath({
        fromPath: current.path,
        specifier,
        actualSet: params.actualSet,
      });
      if (!referencedPath) {
        continue;
      }
      const referencedModifiedChange = modifiedChangesByPath.get(referencedPath);
      if (params.baselineSet.has(referencedPath) && !referencedModifiedChange) {
        continue;
      }
      const dependencies = dependenciesByChangePath.get(current.rootPath) ?? new Set<string>();
      dependencies.add(referencedPath);
      dependenciesByChangePath.set(current.rootPath, dependencies);
      if (!params.baselineSet.has(referencedPath)) {
        addedPaths.add(referencedPath);
      }
      const referencedScanKey = `${current.rootPath}\0${referencedPath}`;
      if (!scannedPathsByRoot.has(referencedScanKey)) {
        queue.push(
          referencedModifiedChange?.savedPath
            ? {
                path: referencedPath,
                rootPath: current.rootPath,
                sourcePath: referencedModifiedChange.savedPath,
              }
            : {
                path: referencedPath,
                rootPath: current.rootPath,
                packageRelativePath: referencedPath,
              },
        );
      }
    }
  }

  return {
    addedPaths: [...addedPaths].toSorted((left, right) => left.localeCompare(right)),
    dependenciesByChangePath: new Map(
      [...dependenciesByChangePath].map(([changePath, dependencies]) => [
        changePath,
        [...dependencies].toSorted((left, right) => left.localeCompare(right)),
      ]),
    ),
  };
}

export async function captureLocalPackageOverrides(params: {
  packageRoot: string;
  recordedPackageRoot?: string;
}): Promise<LocalPackageOverridesPlan | null> {
  if (!(await packageRootExists(params.packageRoot))) {
    return null;
  }
  const baseline = await readPackageDistContentInventoryIfPresent(params.packageRoot);
  if (baseline === null) {
    const packageVersion = await readPackageVersion(params.packageRoot);
    if (isLegacyContentInventoryCompatVersion(packageVersion)) {
      return null;
    }
    throw new Error(
      `missing package dist content inventory ${PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH}`,
    );
  }
  const packageFs = await openFsRoot(params.packageRoot, {
    hardlinks: "reject",
    nonBlockingRead: true,
    symlinks: "reject",
  });

  const actualFiles = await collectPackageDistInventory(params.packageRoot, {
    includeSourceMaps: true,
  });
  const actualSet = new Set(actualFiles);
  const actualCaseFoldedSet = new Set(
    actualFiles.map((relativePath) => relativePath.toLocaleLowerCase("en-US")),
  );
  const changes: LocalPackageOverrideChange[] = [];
  let recoveryDir: string | null = null;
  const ensureRecoveryDir = async () => {
    if (!recoveryDir) {
      const recoveryRoot = path.join(resolveStateDir(), "update-recovery");
      await assertRecoveryRootOutsidePackageRoot(params.packageRoot, recoveryRoot);
      if (params.recordedPackageRoot && params.recordedPackageRoot !== params.packageRoot) {
        await assertRecoveryRootOutsidePackageRoot(params.recordedPackageRoot, recoveryRoot);
      }
      await fs.mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
      recoveryDir = await fs.mkdtemp(path.join(recoveryRoot, "openclaw-local-overrides-"));
    }
    return recoveryDir;
  };

  try {
    const baselineSet = new Set(baseline.map((entry) => entry.path));
    for (const entry of baseline) {
      resolveSafePackagePath(params.packageRoot, entry.path);
      let current;
      try {
        current = await packageFs.read(entry.path, {
          hardlinks: "allow",
          maxBytes: Number.POSITIVE_INFINITY,
          symlinks: "reject",
        });
      } catch (error) {
        if (!actualSet.has(entry.path) && isMissingPathError(error)) {
          await ensureRecoveryDir();
          changes.push({ kind: "deleted", path: entry.path, baseline: entry });
          continue;
        }
        throw error;
      }
      if (!actualSet.has(entry.path)) {
        if (!actualCaseFoldedSet.has(entry.path.toLocaleLowerCase("en-US"))) {
          throw new Error(`package dist inventory changed during override capture: ${entry.path}`);
        }
        await ensureRecoveryDir();
        changes.push({ kind: "deleted", path: entry.path, baseline: entry });
        continue;
      }
      const currentMode = normalizeFileMode(current.stat.mode);
      const currentSha = createHash("sha256").update(current.buffer).digest("hex");
      if (
        currentSha === entry.sha256 &&
        fileModesHaveSameExecutableSemantics(currentMode, entry.mode)
      ) {
        continue;
      }
      const payload = await copyOverridePayload({
        packageFs,
        recoveryDir: await ensureRecoveryDir(),
        relativePath: entry.path,
      });
      changes.push({
        kind: "modified",
        path: entry.path,
        baseline: entry,
        savedPath: payload.savedPath,
        mode: payload.mode,
      });
    }
    const referencedAdded = await collectReferencedAddedOverridePaths({
      packageFs,
      changes,
      actualSet,
      baselineSet,
    });
    for (const change of changes) {
      if (change.kind === "modified") {
        change.dependencies = referencedAdded.dependenciesByChangePath.get(change.path) ?? [];
      }
    }
    const addedOverridePaths = new Set(referencedAdded.addedPaths);
    for (const relativePath of actualFiles) {
      if (!baselineSet.has(relativePath)) {
        addedOverridePaths.add(relativePath);
      }
    }
    for (const relativePath of [...addedOverridePaths].toSorted((left, right) =>
      left.localeCompare(right),
    )) {
      const payload = await copyOverridePayload({
        packageFs,
        recoveryDir: await ensureRecoveryDir(),
        relativePath,
      });
      changes.push({
        kind: "added",
        path: relativePath,
        dependencies: referencedAdded.dependenciesByChangePath.get(relativePath) ?? [],
        savedPath: payload.savedPath,
        mode: payload.mode,
      });
    }

    if (changes.length === 0) {
      return null;
    }
    const finalRecoveryDir = await ensureRecoveryDir();

    const counts = countChanges(changes);
    const result: LocalPackageOverridesResult = {
      status: "none",
      ...counts,
      applied: 0,
      conflicts: [],
      recoveryDir: finalRecoveryDir,
      warnings: [],
    };
    await fs.writeFile(
      path.join(finalRecoveryDir, "manifest.json"),
      JSON.stringify(
        { packageRoot: params.recordedPackageRoot ?? params.packageRoot, changes },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    return {
      packageRoot: params.recordedPackageRoot ?? params.packageRoot,
      recoveryDir: finalRecoveryDir,
      changes,
      result,
    };
  } catch (error) {
    if (recoveryDir) {
      await fs.rm(recoveryDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

function buildCurrentInventoryMap(entries: PackageDistContentInventoryEntry[] | null) {
  return new Map((entries ?? []).map((entry) => [entry.path, entry]));
}

async function preflightLocalOverrides(params: {
  packageRoot: string;
  realPackageRoot: string;
  plan: LocalPackageOverridesPlan;
}): Promise<LocalPackageOverridesResult["conflicts"]> {
  const nextInventory = buildCurrentInventoryMap(
    await readPackageDistContentInventoryIfPresent(params.packageRoot),
  );
  const packageFs = await openFsRoot(params.packageRoot, {
    hardlinks: "reject",
    nonBlockingRead: true,
    symlinks: "reject",
  });
  const conflicts: LocalPackageOverridesResult["conflicts"] = [];
  const targetProbes = new Map<string, LocalPackageOverrideTargetProbe>();
  for (const change of params.plan.changes) {
    const targetPath = resolveSafePackagePath(params.packageRoot, change.path);
    const nextEntry = nextInventory.get(change.path);
    const targetProbe = await probeLocalOverrideTarget(targetPath);
    targetProbes.set(change.path, targetProbe);
    if (targetProbe.status === "error") {
      conflicts.push({ path: change.path, reason: "target-inspection-failed" });
      continue;
    }
    if (change.kind === "added") {
      if (nextEntry || targetProbe.status !== "missing") {
        conflicts.push({ path: change.path, reason: "target-exists" });
      }
      continue;
    }
    if (!change.baseline) {
      conflicts.push({ path: change.path, reason: "target-missing" });
      continue;
    }
    if (targetProbe.status === "blocked") {
      conflicts.push({ path: change.path, reason: "target-changed" });
      continue;
    }
    if (!nextEntry || targetProbe.status === "missing") {
      if (change.kind === "deleted" && targetProbe.status === "missing") {
        continue;
      }
      conflicts.push({
        path: change.path,
        reason: nextEntry && targetProbe.status === "missing" ? "target-missing" : "target-changed",
      });
      continue;
    }
    if (!targetProbe.safeFile) {
      conflicts.push({ path: change.path, reason: "target-changed" });
      continue;
    }
    if (targetProbe.hardlinked) {
      conflicts.push({ path: change.path, reason: "target-hardlinked" });
      continue;
    }
    let targetInspection: { mode: number; sha256: string };
    try {
      // Package verification runs earlier; rehash at replay preflight so later mutations fail closed.
      targetInspection = await inspectLocalOverrideTarget({
        packageFs,
        relativePath: change.path,
        expectedSize: nextEntry.size,
      });
    } catch (error) {
      conflicts.push({
        path: change.path,
        reason:
          error instanceof FsSafeError && error.code === "too-large"
            ? "target-changed"
            : "target-inspection-failed",
      });
      continue;
    }
    if (
      nextEntry.sha256 !== change.baseline.sha256 ||
      targetInspection.sha256 !== nextEntry.sha256 ||
      !fileModesHaveSameExecutableSemantics(nextEntry.mode, change.baseline.mode) ||
      !fileModesHaveSameExecutableSemantics(targetInspection.mode, nextEntry.mode)
    ) {
      conflicts.push({ path: change.path, reason: "target-changed" });
    }
  }
  const conflictingPaths = new Set(conflicts.map((conflict) => conflict.path));
  if (conflictingPaths.size > 0) {
    // Dependency discovery is best-effort, so any conflict makes the full plan fail closed.
    for (const change of params.plan.changes) {
      if (conflictingPaths.has(change.path)) {
        continue;
      }
      conflicts.push({ path: change.path, reason: "target-changed" });
      conflictingPaths.add(change.path);
    }
    return conflicts;
  }
  const topologyPaths = new Map<string, string>();
  let topologyResolutionFailed = false;
  for (const change of params.plan.changes) {
    try {
      topologyPaths.set(
        change.path,
        await resolveLocalOverrideTopologyPath(
          params.packageRoot,
          params.realPackageRoot,
          change.path,
        ),
      );
    } catch {
      topologyResolutionFailed = true;
    }
  }
  if (topologyResolutionFailed) {
    for (const change of params.plan.changes) {
      if (conflictingPaths.has(change.path)) {
        continue;
      }
      conflicts.push({ path: change.path, reason: "target-inspection-failed" });
    }
    return conflicts;
  }
  const conflictPaths = new Set(conflicts.map((conflict) => conflict.path));
  const pathsShareTopology = (left: string, right: string) => {
    const normalizedLeft = topologyPaths.get(left);
    const normalizedRight = topologyPaths.get(right);
    if (!normalizedLeft || !normalizedRight) {
      return false;
    }
    return (
      normalizedLeft === normalizedRight ||
      normalizedLeft.startsWith(`${normalizedRight}${path.sep}`) ||
      normalizedRight.startsWith(`${normalizedLeft}${path.sep}`)
    );
  };
  let propagatedConflict = true;
  while (propagatedConflict) {
    propagatedConflict = false;
    for (const change of params.plan.changes) {
      if (conflictPaths.has(change.path)) {
        continue;
      }
      if (
        [...conflictPaths].some((conflictPath) => pathsShareTopology(change.path, conflictPath))
      ) {
        conflicts.push({ path: change.path, reason: "target-changed" });
        conflictPaths.add(change.path);
        propagatedConflict = true;
      }
    }
    for (const change of params.plan.changes) {
      if (change.kind === "deleted" || conflictPaths.has(change.path)) {
        continue;
      }
      if ((change.dependencies ?? []).some((dependency) => conflictPaths.has(dependency))) {
        conflicts.push({ path: change.path, reason: "target-changed" });
        conflictPaths.add(change.path);
        propagatedConflict = true;
      }
    }
    for (const change of params.plan.changes) {
      if (change.kind !== "added" || conflictPaths.has(change.path)) {
        continue;
      }
      const importers = params.plan.changes.filter(
        (candidate) =>
          candidate.kind !== "deleted" && (candidate.dependencies ?? []).includes(change.path),
      );
      if (importers.length > 0 && importers.every((importer) => conflictPaths.has(importer.path))) {
        conflicts.push({ path: change.path, reason: "target-changed" });
        conflictPaths.add(change.path);
        propagatedConflict = true;
      }
    }
    for (const change of params.plan.changes) {
      if (change.kind !== "deleted" || conflictPaths.has(change.path)) {
        continue;
      }
      if (conflictPaths.size > 0) {
        conflicts.push({ path: change.path, reason: "target-changed" });
        conflictPaths.add(change.path);
        propagatedConflict = true;
      }
    }
  }
  return conflicts;
}

function localOverrideInspectionConflict(
  plan: LocalPackageOverridesPlan,
): LocalPackageOverridesResult {
  return {
    ...plan.result,
    status: "conflict",
    applied: 0,
    conflicts: plan.changes.map((change) => ({
      path: change.path,
      reason: "target-inspection-failed" as const,
    })),
    warnings: [
      "Local OpenClaw changes were preserved but not reapplied because the updated package could not be safely inspected.",
    ],
  };
}

export async function applyLocalPackageOverrides(params: {
  packageRoot: string;
  plan: LocalPackageOverridesPlan | null;
  reapply: boolean;
}): Promise<LocalPackageOverridesResult> {
  if (!params.plan) {
    return emptyResult("none");
  }

  if (!params.reapply) {
    return {
      ...params.plan.result,
      status: "preserved",
      applied: 0,
      warnings: [
        "Local OpenClaw changes were preserved in the recovery bundle and were not reapplied. Inspect the bundle and copy back trusted files manually, or run the update with --reapply-local-overrides when you want trusted edits replayed during that update.",
      ],
    };
  }

  const packageRootIdentity = await readLocalOverridePackageRootIdentity(params.packageRoot).catch(
    () => null,
  );
  if (!packageRootIdentity) {
    return localOverrideInspectionConflict(params.plan);
  }
  const conflicts = await preflightLocalOverrides({
    packageRoot: params.packageRoot,
    realPackageRoot: packageRootIdentity.realPath,
    plan: params.plan,
  }).catch(() => null);
  if (!conflicts) {
    return localOverrideInspectionConflict(params.plan);
  }
  const conflictPaths = new Set(conflicts.map((conflict) => conflict.path));
  const changesToApply: LocalPackageOverrideChange[] = [];
  for (const change of params.plan.changes) {
    if (conflictPaths.has(change.path)) {
      continue;
    }
    if (
      change.kind === "deleted" &&
      (await probeLocalOverrideTarget(resolveSafePackagePath(params.packageRoot, change.path)))
        .status === "missing"
    ) {
      continue;
    }
    changesToApply.push(change);
  }
  if (changesToApply.length === 0) {
    return {
      ...params.plan.result,
      status: conflicts.length > 0 ? "conflict" : "applied",
      applied: 0,
      conflicts,
      warnings:
        conflicts.length > 0
          ? [
              "Local OpenClaw changes were preserved but not reapplied because the update changed the same file(s).",
            ]
          : [],
    };
  }

  let rollbackDir: string | null = null;
  const rollbackEntries: Array<{
    path: string;
    applied?: PackageDistContentInventoryEntry;
    backupPath?: string;
    backupMode?: number;
    cleanupPaths?: string[];
  }> = [];
  let applied = 0;
  let preserveRollbackDir = false;
  let packageFs: LocalOverridePackageRoot | undefined;
  try {
    packageFs = await openFsRoot(params.packageRoot, {
      hardlinks: "reject",
      mkdir: true,
      symlinks: "reject",
    });
    const openedPackageRootIdentity = await readLocalOverridePackageRootIdentity(
      packageFs.rootReal,
    ).catch(() => null);
    if (
      !openedPackageRootIdentity ||
      !isSameLocalOverridePackageRoot(packageRootIdentity, openedPackageRootIdentity)
    ) {
      return localOverrideInspectionConflict(params.plan);
    }
    rollbackDir = await fs.mkdtemp(path.join(params.plan.recoveryDir, "rollback-"));
    for (const change of changesToApply) {
      const backupPath = path.join(rollbackDir, change.path);

      if (change.kind === "deleted") {
        if (!change.baseline) {
          throw new Error(`missing local override baseline for ${change.path}`);
        }
        const backupMode = await deleteLocalOverrideTarget({
          packageFs,
          relativePath: change.path,
          expected: change.baseline,
          backupPath,
        });
        rollbackEntries.push({ path: change.path, backupPath, backupMode });
      } else {
        if (!change.savedPath) {
          throw new Error(`missing saved override payload for ${change.path}`);
        }
        const appliedEntry = await buildLocalOverrideInventoryEntry({
          relativePath: change.path,
          sourcePath: change.savedPath,
          mode: change.mode,
        });
        const cleanupPaths = await replaceLocalOverrideTarget({
          packageFs,
          relativePath: change.path,
          sourcePath: change.savedPath,
          mode: change.mode,
          expected: change.kind === "modified" ? change.baseline : undefined,
          backupPath: change.kind === "modified" ? backupPath : undefined,
          onCommitted: (committedCleanupPaths, backupMode) => {
            rollbackEntries.push({
              path: change.path,
              applied: appliedEntry,
              cleanupPaths: committedCleanupPaths,
              ...(change.kind === "modified" ? { backupPath, backupMode } : {}),
            });
          },
        });
        while (cleanupPaths.length > 0) {
          await removeLocalOverrideCleanupPath(packageFs, cleanupPaths[0]);
          cleanupPaths.shift();
        }
      }
      applied += 1;
    }
  } catch (applyError) {
    const rollbackFailures = new Map<string, string[]>();
    const recordRollbackFailure = (relativePath: string, action: string, error: unknown) => {
      const messages = rollbackFailures.get(relativePath) ?? [];
      messages.push(`${action}: ${formatErrorMessage(error)}`);
      rollbackFailures.set(relativePath, messages);
    };
    if (applyError instanceof LocalOverrideRollbackError) {
      recordRollbackFailure(applyError.relativePath, applyError.action, applyError.rollbackError);
    }
    for (const entry of rollbackEntries.toReversed()) {
      if (entry.cleanupPaths && packageFs) {
        for (const cleanupPath of entry.cleanupPaths) {
          try {
            await removeLocalOverrideCleanupPath(packageFs, cleanupPath);
          } catch (error) {
            recordRollbackFailure(entry.path, "remove mutation backup", error);
          }
        }
      }
      let removeError: unknown;
      if (entry.applied && packageFs && rollbackDir) {
        try {
          await deleteLocalOverrideTarget({
            packageFs,
            relativePath: entry.path,
            expected: entry.applied,
            backupPath: path.join(rollbackDir, "applied", entry.path),
          });
        } catch (error) {
          removeError = error;
        }
      }
      if (removeError) {
        recordRollbackFailure(entry.path, "remove partial target", removeError);
      }
      if (entry.backupPath && packageFs) {
        try {
          const cleanupPaths = await replaceLocalOverrideTarget({
            packageFs,
            relativePath: entry.path,
            sourcePath: entry.backupPath,
            mode: entry.backupMode,
          });
          for (const cleanupPath of cleanupPaths) {
            await removeLocalOverrideCleanupPath(packageFs, cleanupPath);
          }
        } catch (error) {
          recordRollbackFailure(entry.path, "restore original target", error);
        }
      }
    }
    preserveRollbackDir = rollbackFailures.size > 0;
    const failureReasonByPath = new Map<string, LocalPackageOverrideConflictReason>(
      changesToApply.map((change) => [change.path, "apply-failed"]),
    );
    for (const relativePath of rollbackFailures.keys()) {
      failureReasonByPath.set(relativePath, "rollback-failed");
    }
    const rollbackWarnings = [...rollbackFailures].map(
      ([relativePath, messages]) => `Rollback failed for ${relativePath}: ${messages.join("; ")}`,
    );
    return {
      ...params.plan.result,
      status: "error",
      applied: 0,
      conflicts: [...failureReasonByPath].map(([relativePath, reason]) => ({
        path: relativePath,
        reason,
      })),
      warnings: [
        "Local OpenClaw changes were preserved but could not be reapplied.",
        ...(rollbackFailures.size > 0
          ? [
              `Rollback could not fully restore ${rollbackFailures.size} installed file(s); the package may be partially modified. Inspect the preserved rollback data before retrying.`,
              ...rollbackWarnings,
            ]
          : []),
      ],
    };
  } finally {
    if (rollbackDir && !preserveRollbackDir) {
      await fs.rm(rollbackDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    ...params.plan.result,
    status: conflicts.length > 0 ? "conflict" : "applied",
    applied,
    conflicts,
    warnings:
      conflicts.length > 0
        ? [
            "Local OpenClaw changes were preserved but not reapplied because the update changed the same file(s).",
          ]
        : [],
  };
}
