// Doctor cleanup for state left by the retired experimental Workspaces plugin.
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { HealthCheck, HealthRepairEffect } from "./health-checks.js";

const CHECK_ID = "core/doctor/removed-workspaces-state";

function resolveRemovedWorkspacesStateDir(): string {
  return path.join(resolveStateDir(process.env), "workspaces");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function repairEffect(target: string, dryRun: boolean): HealthRepairEffect {
  return {
    kind: "state",
    action: dryRun ? "would-remove-retired-workspaces-state" : "remove-retired-workspaces-state",
    target,
    dryRunSafe: false,
  };
}

export const removedWorkspacesStateCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  description: "State from the retired experimental Workspaces plugin has been removed.",
  source: "doctor",
  async detect(_ctx, scope) {
    const target = resolveRemovedWorkspacesStateDir();
    const scopedPaths = new Set(scope?.paths ?? []);
    if ((scopedPaths.size > 0 && !scopedPaths.has(target)) || !(await pathExists(target))) {
      return [];
    }
    return [
      {
        checkId: CHECK_ID,
        severity: "warning",
        message: `Retired Workspaces plugin state remains at ${target}.`,
        path: target,
        fixHint: "Run `openclaw doctor --fix` to remove the stale plugin state.",
      },
    ];
  },
  async repair(ctx) {
    const target = resolveRemovedWorkspacesStateDir();
    if (!(await pathExists(target))) {
      return {
        status: "skipped",
        reason: "retired Workspaces plugin state no longer exists",
        changes: [],
      };
    }
    const dryRun = ctx.dryRun === true;
    const effects = [repairEffect(target, dryRun)];
    if (dryRun) {
      return { changes: [`Would remove retired Workspaces plugin state at ${target}.`], effects };
    }
    await rm(target, { force: true, recursive: true });
    return { changes: [`Removed retired Workspaces plugin state at ${target}.`], effects };
  },
};
