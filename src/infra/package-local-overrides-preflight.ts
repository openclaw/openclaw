import { FsSafeError, root as openFsRoot } from "./fs-safe.js";
import {
  readPackageDistContentInventoryIfPresent,
  type PackageDistContentInventoryEntry,
} from "./package-dist-inventory.js";
import {
  fileModesHaveSameExecutableSemantics,
  inspectLocalOverrideTarget,
  probeLocalOverrideTarget,
  resolveLocalOverrideTopologyPath,
  resolveSafePackagePath,
  type LocalPackageOverridesPlan,
  type LocalPackageOverridesResult,
  type LocalPackageOverrideTargetProbe,
} from "./package-local-overrides-shared.js";

function buildCurrentInventoryMap(entries: PackageDistContentInventoryEntry[] | null) {
  return new Map((entries ?? []).map((entry) => [entry.path, entry]));
}

export async function preflightLocalOverrides(params: {
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
  let topologyResolutionFailed = false;
  for (const change of params.plan.changes) {
    try {
      await resolveLocalOverrideTopologyPath(
        params.packageRoot,
        params.realPackageRoot,
        change.path,
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
  return conflicts;
}

export function localOverrideInspectionConflict(
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
