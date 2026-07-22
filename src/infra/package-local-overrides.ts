import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getFsSafePythonConfig } from "@openclaw/fs-safe/config";
import { formatErrorMessage } from "./errors.js";
import { root as openFsRoot } from "./fs-safe.js";
import type { PackageDistContentInventoryEntry } from "./package-dist-inventory.js";
import {
  localOverrideInspectionConflict,
  preflightLocalOverrides,
} from "./package-local-overrides-preflight.js";
import {
  assertLocalOverrideMutationTopology,
  buildLocalOverrideInventoryEntry,
  emptyResult,
  fileModesHaveSameExecutableSemantics,
  isMissingPathError,
  isSameLocalOverridePackageRoot,
  mergeLocalOverrideFileMode,
  normalizeDistPath,
  normalizeFileMode,
  probeLocalOverrideTarget,
  readLocalOverridePackageRootIdentity,
  resolveSafePackagePath,
  type LocalOverridePackageRoot,
  type LocalPackageOverrideChange,
  type LocalPackageOverrideConflictReason,
  type LocalPackageOverridesPlan,
  type LocalPackageOverridesResult,
} from "./package-local-overrides-shared.js";

export { captureLocalPackageOverrides } from "./package-local-overrides-capture.js";
export type {
  LocalPackageOverridesPlan,
  LocalPackageOverridesResult,
} from "./package-local-overrides-shared.js";

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

  const recoveryOnlyChanges = params.plan.changes.filter((change) => change.reapply === false);
  if (recoveryOnlyChanges.length > 0) {
    return {
      ...params.plan.result,
      status: "preserved",
      applied: 0,
      warnings: [
        `${recoveryOnlyChanges.length} local content-hashed file(s) were preserved in the recovery bundle but were not automatically reapplied. To avoid a partial override set, no local changes were reapplied; inspect the bundle and restore trusted files manually if needed.`,
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
          const cleanupPath = cleanupPaths[0];
          if (cleanupPath === undefined) {
            break;
          }
          await removeLocalOverrideCleanupPath(packageFs, cleanupPath);
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
