import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../utils.js";
import {
  collectPackageDistInventory,
  readPackageDistContentInventoryIfPresent,
  type PackageDistContentInventoryEntry,
} from "./package-dist-inventory.js";

type LocalPackageOverrideKind = "added" | "modified" | "deleted";

type LocalPackageOverrideChange = {
  kind: LocalPackageOverrideKind;
  path: string;
  baseline?: PackageDistContentInventoryEntry;
  dependencies?: string[];
  savedPath?: string;
  mode?: number;
};

export type LocalPackageOverridesResult = {
  status: "unsupported" | "none" | "preserved" | "applied" | "conflict" | "error";
  added: number;
  modified: number;
  deleted: number;
  applied: number;
  conflicts: Array<{
    path: string;
    reason: "target-changed" | "target-exists" | "target-missing" | "apply-failed";
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
  const normalized = normalizeRelativePath(relativePath);
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

async function hashFileSha256(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function normalizeFileMode(mode: number): number {
  return mode & 0o777;
}

async function copyFileWithMode(source: string, destination: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  if (mode !== undefined) {
    await fs.chmod(destination, mode).catch(() => undefined);
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

const LOCAL_IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/gu;

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
  const queue = params.changes
    .filter((change) => change.kind === "modified" && change.savedPath)
    .map((change) => ({
      path: change.path,
      rootPath: change.path,
      sourcePath: change.savedPath as string,
    }));

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    // Shared added files must be rescanned per modified root so partial-conflict
    // reapply keeps each clean importer with its full dependency closure.
    const scanKey = `${current.rootPath}\0${current.path}`;
    if (scannedPathsByRoot.has(scanKey)) {
      continue;
    }
    scannedPathsByRoot.add(scanKey);
    const source = await fs.readFile(current.sourcePath, "utf8").catch(() => "");
    for (const match of source.matchAll(LOCAL_IMPORT_SPECIFIER_PATTERN)) {
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
  const baseline = await readPackageDistContentInventoryIfPresent(params.packageRoot);
  if (baseline === null) {
    return null;
  }

  const actualFiles = await collectPackageDistInventory(params.packageRoot);
  const actualSet = new Set(actualFiles);
  const changes: LocalPackageOverrideChange[] = [];
  let recoveryDir: string | null = null;
  const ensureRecoveryDir = async () => {
    recoveryDir ??= await fs.mkdtemp(
      path.join(path.dirname(params.packageRoot), "openclaw-local-overrides-"),
    );
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
      const currentSha = await hashFileSha256(absolutePath);
      if (currentSha === entry.sha256) {
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
    for (const relativePath of referencedAdded.addedPaths) {
      const payload = await copyOverridePayload({
        packageRoot: params.packageRoot,
        recoveryDir: await ensureRecoveryDir(),
        relativePath,
      });
      changes.push({
        kind: "added",
        path: relativePath,
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
  plan: LocalPackageOverridesPlan;
}): Promise<LocalPackageOverridesResult["conflicts"]> {
  const nextInventory = buildCurrentInventoryMap(
    await readPackageDistContentInventoryIfPresent(params.packageRoot),
  );
  const conflicts: LocalPackageOverridesResult["conflicts"] = [];
  for (const change of params.plan.changes) {
    const targetPath = resolveSafePackagePath(params.packageRoot, change.path);
    const nextEntry = nextInventory.get(change.path);
    if (change.kind === "added") {
      if (nextEntry || (await pathExists(targetPath))) {
        conflicts.push({ path: change.path, reason: "target-exists" });
      }
      continue;
    }
    if (!change.baseline) {
      conflicts.push({ path: change.path, reason: "target-missing" });
      continue;
    }
    const targetExists = await pathExists(targetPath);
    if (!nextEntry || !targetExists) {
      if (change.kind === "deleted" && !targetExists) {
        continue;
      }
      conflicts.push({
        path: change.path,
        reason: nextEntry ? "target-missing" : "target-changed",
      });
      continue;
    }
    if (nextEntry.sha256 !== change.baseline.sha256) {
      conflicts.push({ path: change.path, reason: "target-changed" });
    }
  }
  const conflictPaths = new Set(conflicts.map((conflict) => conflict.path));
  let propagatedConflict = true;
  while (propagatedConflict) {
    propagatedConflict = false;
    for (const change of params.plan.changes) {
      if (change.kind !== "modified" || conflictPaths.has(change.path)) {
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
          candidate.kind === "modified" && (candidate.dependencies ?? []).includes(change.path),
      );
      if (importers.length > 0 && importers.every((importer) => conflictPaths.has(importer.path))) {
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

  const conflicts = await preflightLocalOverrides({
    packageRoot: params.packageRoot,
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

  const rollbackDir = await fs.mkdtemp(path.join(params.plan.recoveryDir, "rollback-"));
  const rollbackEntries: Array<{ path: string; backupPath?: string }> = [];
  let applied = 0;
  try {
    for (const change of changesToApply) {
      const targetPath = resolveSafePackagePath(params.packageRoot, change.path);
      const backupPath = path.join(rollbackDir, change.path);
      if (await pathExists(targetPath)) {
        await copyFileWithMode(targetPath, backupPath);
        rollbackEntries.push({ path: change.path, backupPath });
      } else {
        rollbackEntries.push({ path: change.path });
      }

      if (change.kind === "deleted") {
        await fs.rm(targetPath, { force: true });
      } else {
        if (!change.savedPath) {
          throw new Error(`missing saved override payload for ${change.path}`);
        }
        await copyFileWithMode(change.savedPath, targetPath, change.mode);
      }
      applied += 1;
    }
  } catch {
    for (const entry of rollbackEntries.toReversed()) {
      const targetPath = resolveSafePackagePath(params.packageRoot, entry.path);
      await fs.rm(targetPath, { force: true }).catch(() => undefined);
      if (entry.backupPath) {
        await copyFileWithMode(entry.backupPath, targetPath).catch(() => undefined);
      }
    }
    return {
      ...params.plan.result,
      status: "error",
      applied: 0,
      conflicts: changesToApply.map((change) => ({
        path: change.path,
        reason: "apply-failed",
      })),
      warnings: ["Local OpenClaw changes were preserved but could not be reapplied."],
    };
  } finally {
    await fs.rm(rollbackDir, { recursive: true, force: true }).catch(() => undefined);
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
