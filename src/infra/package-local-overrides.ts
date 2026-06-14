import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { pathExists } from "../utils.js";
import { formatErrorMessage } from "./errors.js";
import { root as openFsRoot } from "./fs-safe.js";
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

function isMissingPathError(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
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
  const [realPackageRoot, resolvedRecoveryRoot] = await Promise.all([
    fs.realpath(packageRoot),
    resolvePathTopology(recoveryRoot),
  ]);
  if (
    resolvedRecoveryRoot === realPackageRoot ||
    resolvedRecoveryRoot.startsWith(`${realPackageRoot}${path.sep}`)
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

async function hashFileSha256(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
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

async function copyFileWithMode(source: string, destination: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  if (mode !== undefined && process.platform !== "win32") {
    await fs.chmod(destination, mode);
  }
}

type LocalOverridePackageRoot = Awaited<ReturnType<typeof openFsRoot>>;

function createLocalOverrideMutationPath(relativePath: string, label: string): string {
  const normalized = normalizeDistPath(relativePath);
  return path.posix.join(
    path.posix.dirname(normalized),
    `.openclaw-override-${label}-${randomUUID()}.tmp`,
  );
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
  const sourceAbsolutePath = resolveSafePackagePath(params.packageFs.rootDir, params.sourcePath);
  await fs.link(
    sourceAbsolutePath,
    resolveSafePackagePath(params.packageFs.rootDir, params.relativePath),
  );
  await assertLocalOverrideMutationTopology({
    packageRoot: params.packageFs.rootDir,
    realPackageRoot: params.packageFs.rootReal,
    relativePath: params.relativePath,
  });
  await params.packageFs.remove(params.sourcePath);
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

async function moveExpectedLocalOverrideTarget(params: {
  packageFs: LocalOverridePackageRoot;
  relativePath: string;
  expected: PackageDistContentInventoryEntry;
  allowHardlinks?: boolean;
}): Promise<{ movedPath: string; content: Buffer; mode: number }> {
  const movedPath = createLocalOverrideMutationPath(params.relativePath, "previous");
  let targetMoved = false;
  try {
    if (params.allowHardlinks) {
      await assertLocalOverrideMutationTopology({
        packageRoot: params.packageFs.rootDir,
        realPackageRoot: params.packageFs.rootReal,
        relativePath: params.relativePath,
      });
      await fs.rename(
        resolveSafePackagePath(params.packageFs.rootDir, params.relativePath),
        resolveSafePackagePath(params.packageFs.rootDir, movedPath),
      );
      targetMoved = true;
      await assertLocalOverrideMutationTopology({
        packageRoot: params.packageFs.rootDir,
        realPackageRoot: params.packageFs.rootReal,
        relativePath: movedPath,
      });
    } else {
      await params.packageFs.move(params.relativePath, movedPath);
      targetMoved = true;
    }
    const moved = await params.packageFs.read(movedPath, {
      hardlinks: params.allowHardlinks ? "allow" : "reject",
      maxBytes: Number.POSITIVE_INFINITY,
      symlinks: "reject",
    });
    const mode = normalizeFileMode(moved.stat.mode);
    const sha256 = createHash("sha256").update(moved.buffer).digest("hex");
    if (
      sha256 !== params.expected.sha256 ||
      (process.platform !== "win32" && mode !== normalizeFileMode(params.expected.mode))
    ) {
      throw new Error(`local override target changed during mutation: ${params.relativePath}`);
    }
    return { movedPath, content: moved.buffer, mode };
  } catch (error) {
    if (targetMoved) {
      await restoreMovedLocalOverrideTarget({
        packageFs: params.packageFs,
        movedPath,
        relativePath: params.relativePath,
      }).catch(() => undefined);
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
}): Promise<void> {
  const temporaryPath = createLocalOverrideMutationPath(params.relativePath, "next");
  let backupWritten = false;
  let movedPath: string | undefined;
  try {
    await params.packageFs.copyIn(temporaryPath, params.sourcePath, {
      maxBytes: Number.POSITIVE_INFINITY,
      mkdir: true,
      mode: params.mode,
      sourceHardlinks: "reject",
    });
    if (params.mode !== undefined && process.platform !== "win32") {
      const temporary = await params.packageFs.open(temporaryPath, {
        hardlinks: "reject",
        symlinks: "reject",
      });
      try {
        await temporary.handle.chmod(params.mode);
      } finally {
        await temporary.handle.close();
      }
    }
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
      await writeRollbackBackup({
        backupPath: params.backupPath,
        content: moved.content,
        mode: moved.mode,
      });
      backupWritten = true;
    }
    await publishLocalOverrideTarget({
      packageFs: params.packageFs,
      sourcePath: temporaryPath,
      relativePath: params.relativePath,
    });
    if (movedPath) {
      await params.packageFs.remove(movedPath);
      movedPath = undefined;
    }
  } catch (error) {
    if (movedPath) {
      const restored = await restoreMovedLocalOverrideTarget({
        packageFs: params.packageFs,
        movedPath,
        relativePath: params.relativePath,
      })
        .then(() => true)
        .catch(() => false);
      if (!restored && backupWritten) {
        await params.packageFs.remove(movedPath).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await params.packageFs.remove(temporaryPath).catch(() => undefined);
  }
}

async function deleteLocalOverrideTarget(params: {
  packageFs: LocalOverridePackageRoot;
  relativePath: string;
  expected: PackageDistContentInventoryEntry;
  backupPath: string;
}): Promise<void> {
  const moved = await moveExpectedLocalOverrideTarget({
    packageFs: params.packageFs,
    relativePath: params.relativePath,
    expected: params.expected,
    allowHardlinks: true,
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
  } catch (error) {
    const restored = await restoreMovedLocalOverrideTarget({
      packageFs: params.packageFs,
      movedPath: moved.movedPath,
      relativePath: params.relativePath,
    })
      .then(() => true)
      .catch(() => false);
    if (!restored && backupWritten) {
      await params.packageFs.remove(moved.movedPath).catch(() => undefined);
    }
    throw error;
  }
}

async function copyOverridePayload(params: {
  packageRoot: string;
  recoveryDir: string;
  relativePath: string;
}): Promise<{ savedPath: string; mode: number }> {
  const source = resolveSafePackagePath(params.packageRoot, params.relativePath);
  const stats = await fs.lstat(source);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`unsafe local override file: ${params.relativePath}`);
  }
  const savedPath = path.join(
    params.recoveryDir,
    "files",
    normalizeRelativePath(params.relativePath),
  );
  await copyFileWithMode(source, savedPath, normalizeFileMode(stats.mode));
  return { savedPath, mode: normalizeFileMode(stats.mode) };
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
  packageRoot: string;
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
  const queue = [
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
        sourcePath: resolveSafePackagePath(params.packageRoot, relativePath),
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
    const source = await fs.readFile(current.sourcePath, "utf8").catch(() => "");
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
        queue.push({
          path: referencedPath,
          rootPath: current.rootPath,
          sourcePath:
            referencedModifiedChange?.savedPath ??
            resolveSafePackagePath(params.packageRoot, referencedPath),
        });
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

  const actualFiles = await collectPackageDistInventory(params.packageRoot);
  const actualSet = new Set(actualFiles);
  const changes: LocalPackageOverrideChange[] = [];
  let recoveryDir: string | null = null;
  const ensureRecoveryDir = async () => {
    if (!recoveryDir) {
      const recoveryRoot = path.join(resolveStateDir(), "update-recovery");
      await assertRecoveryRootOutsidePackageRoot(params.packageRoot, recoveryRoot);
      await fs.mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
      recoveryDir = await fs.mkdtemp(path.join(recoveryRoot, "openclaw-local-overrides-"));
    }
    return recoveryDir;
  };

  try {
    const baselineSet = new Set(baseline.map((entry) => entry.path));
    for (const entry of baseline) {
      const absolutePath = resolveSafePackagePath(params.packageRoot, entry.path);
      if (!actualSet.has(entry.path) || !(await pathExists(absolutePath))) {
        await ensureRecoveryDir();
        changes.push({ kind: "deleted", path: entry.path, baseline: entry });
        continue;
      }
      const currentStats = await fs.lstat(absolutePath);
      const currentMode = normalizeFileMode(currentStats.mode);
      const currentSha = await hashFileSha256(absolutePath);
      if (
        currentSha === entry.sha256 &&
        (process.platform === "win32" || currentMode === normalizeFileMode(entry.mode))
      ) {
        continue;
      }
      const payload = await copyOverridePayload({
        packageRoot: params.packageRoot,
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
      packageRoot: params.packageRoot,
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
        packageRoot: params.packageRoot,
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
      JSON.stringify({ packageRoot: params.packageRoot, changes }, null, 2) + "\n",
      "utf8",
    );
    return { packageRoot: params.packageRoot, recoveryDir: finalRecoveryDir, changes, result };
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
    if (targetProbe.hardlinked && change.kind !== "deleted") {
      conflicts.push({ path: change.path, reason: "target-hardlinked" });
      continue;
    }
    let targetSha: string;
    try {
      // Package verification runs earlier; rehash at replay preflight so later mutations fail closed.
      targetSha = await hashFileSha256(targetPath);
    } catch {
      conflicts.push({ path: change.path, reason: "target-inspection-failed" });
      continue;
    }
    if (
      nextEntry.sha256 !== change.baseline.sha256 ||
      targetSha !== nextEntry.sha256 ||
      nextEntry.mode !== normalizeFileMode(change.baseline.mode) ||
      (process.platform !== "win32" && targetProbe.mode !== normalizeFileMode(nextEntry.mode))
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

  const realPackageRoot = await fs.realpath(params.packageRoot).catch(() => null);
  if (!realPackageRoot) {
    return {
      ...params.plan.result,
      status: "conflict",
      applied: 0,
      conflicts: params.plan.changes.map((change) => ({
        path: change.path,
        reason: "target-inspection-failed" as const,
      })),
      warnings: [
        "Local OpenClaw changes were preserved but not reapplied because the update changed the same file(s).",
      ],
    };
  }
  const conflicts = await preflightLocalOverrides({
    packageRoot: params.packageRoot,
    realPackageRoot,
    plan: params.plan,
  });
  const conflictPaths = new Set(conflicts.map((conflict) => conflict.path));
  const changesToApply = params.plan.changes.filter((change) => !conflictPaths.has(change.path));
  if (changesToApply.length === 0 && conflicts.length > 0) {
    return {
      ...params.plan.result,
      status: "conflict",
      applied: 0,
      conflicts,
      warnings: [
        "Local OpenClaw changes were preserved but not reapplied because the update changed the same file(s).",
      ],
    };
  }

  let rollbackDir: string | null = null;
  const rollbackEntries: Array<{
    path: string;
    applied?: PackageDistContentInventoryEntry;
    backupPath?: string;
    backupMode?: number;
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
    rollbackDir = await fs.mkdtemp(path.join(params.plan.recoveryDir, "rollback-"));
    for (const change of changesToApply) {
      const backupPath = path.join(rollbackDir, change.path);

      if (change.kind === "deleted") {
        if (!change.baseline) {
          throw new Error(`missing local override baseline for ${change.path}`);
        }
        await deleteLocalOverrideTarget({
          packageFs,
          relativePath: change.path,
          expected: change.baseline,
          backupPath,
        });
      } else {
        if (!change.savedPath) {
          throw new Error(`missing saved override payload for ${change.path}`);
        }
        const appliedEntry = await buildLocalOverrideInventoryEntry({
          relativePath: change.path,
          sourcePath: change.savedPath,
          mode: change.mode,
        });
        await replaceLocalOverrideTarget({
          packageFs,
          relativePath: change.path,
          sourcePath: change.savedPath,
          mode: change.mode,
          expected: change.kind === "modified" ? change.baseline : undefined,
          backupPath: change.kind === "modified" ? backupPath : undefined,
        });
        rollbackEntries.push({
          path: change.path,
          applied: appliedEntry,
          ...(change.kind === "modified" ? { backupPath, backupMode: change.baseline?.mode } : {}),
        });
      }
      if (change.kind === "deleted") {
        rollbackEntries.push({ path: change.path, backupPath, backupMode: change.baseline?.mode });
      }
      applied += 1;
    }
  } catch {
    const rollbackFailures = new Map<string, string[]>();
    const recordRollbackFailure = (relativePath: string, action: string, error: unknown) => {
      const messages = rollbackFailures.get(relativePath) ?? [];
      messages.push(`${action}: ${formatErrorMessage(error)}`);
      rollbackFailures.set(relativePath, messages);
    };
    for (const entry of rollbackEntries.toReversed()) {
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
          await replaceLocalOverrideTarget({
            packageFs,
            relativePath: entry.path,
            sourcePath: entry.backupPath,
            mode: entry.backupMode,
          });
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
