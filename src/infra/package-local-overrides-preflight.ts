import { FsSafeError, root as openFsRoot } from "./fs-safe.js";
import { readPackageDistContentInventoryIfPresent } from "./package-dist-inventory.js";
import {
  fileModesHaveSameExecutableSemantics,
  inspectLocalOverrideTarget,
  probeLocalOverrideTarget,
  resolveLocalOverrideTopologyPath,
  resolveSafePackagePath,
  type LocalPackageOverrideChange,
  type LocalPackageOverrideConflictReason,
  type LocalPackageOverridesPlan,
  type LocalPackageOverridesResult,
} from "./package-local-overrides-shared.js";

export async function preflightLocalOverrides(params: {
  packageRoot: string;
  realPackageRoot: string;
  plan: LocalPackageOverridesPlan;
}): Promise<LocalPackageOverridesResult["conflicts"]> {
  const nextInventory = new Map(
    ((await readPackageDistContentInventoryIfPresent(params.packageRoot)) ?? []).map((entry) => [
      entry.path,
      entry,
    ]),
  );
  const packageFs = await openFsRoot(params.packageRoot, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  const inspectChange = async (
    change: LocalPackageOverrideChange,
  ): Promise<LocalPackageOverrideConflictReason | undefined> => {
    const targetPath = resolveSafePackagePath(params.packageRoot, change.path);
    const nextEntry = nextInventory.get(change.path);
    const targetProbe = await probeLocalOverrideTarget(targetPath);
    if (targetProbe.status === "error") {
      return "target-inspection-failed";
    }
    if (change.kind === "added") {
      return nextEntry || targetProbe.status !== "missing" ? "target-exists" : undefined;
    }
    if (targetProbe.status === "blocked") {
      return "target-changed";
    }
    if (!nextEntry || targetProbe.status === "missing") {
      if (change.kind === "deleted" && targetProbe.status === "missing") {
        return undefined;
      }
      return nextEntry && targetProbe.status === "missing" ? "target-missing" : "target-changed";
    }
    if (!targetProbe.safeFile) {
      return "target-changed";
    }
    if (targetProbe.hardlinked) {
      return "target-hardlinked";
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
      return error instanceof FsSafeError && error.code === "too-large"
        ? "target-changed"
        : "target-inspection-failed";
    }
    if (
      nextEntry.sha256 !== change.baseline.sha256 ||
      targetInspection.sha256 !== nextEntry.sha256 ||
      !fileModesHaveSameExecutableSemantics(nextEntry.mode, change.baseline.mode) ||
      !fileModesHaveSameExecutableSemantics(targetInspection.mode, nextEntry.mode)
    ) {
      return "target-changed";
    }
    return undefined;
  };
  const conflicts: LocalPackageOverridesResult["conflicts"] = [];
  for (const change of params.plan.changes) {
    const reason = await inspectChange(change);
    if (reason) {
      conflicts.push({ path: change.path, reason });
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
      conflicts.push({ path: change.path, reason: "target-inspection-failed" });
    }
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
