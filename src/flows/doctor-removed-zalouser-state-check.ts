// Doctor cleanup for credential state left by the removed zalouser channel plugin.
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { HealthCheck, HealthRepairEffect } from "./health-checks.js";

const CHECK_ID = "core/doctor/removed-zalouser-state";

// Mirrors resolveLegacyZalouserCredentialsDir from the removed plugin: the
// dedicated credentials/zalouser subdir holding credentials.json / credentials-<profile>.json.
function resolveRemovedZalouserStateDir(): string {
  return path.join(resolveStateDir(process.env), "credentials", "zalouser");
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function hasRemovedZalouserFingerprint(target: string): Promise<boolean> {
  if (!(await isDirectory(target))) {
    return false;
  }
  // Only reclaim the dir when it actually holds this plugin's credential files,
  // so an unrelated directory that happens to share the path is left untouched.
  const entries = await readdir(target);
  return entries.some((entry) => entry === "credentials.json" || entry.startsWith("credentials-"));
}

function repairEffect(target: string, dryRun: boolean): HealthRepairEffect {
  return {
    kind: "state",
    action: dryRun ? "would-remove-removed-zalouser-state" : "remove-removed-zalouser-state",
    target,
    dryRunSafe: false,
  };
}

export const removedZalouserStateCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  description: "Credential state from the removed zalouser channel plugin has been removed.",
  source: "doctor",
  async detect(_ctx, scope) {
    const target = resolveRemovedZalouserStateDir();
    const scopedPaths = new Set(scope?.paths ?? []);
    if (
      (scopedPaths.size > 0 && !scopedPaths.has(target)) ||
      !(await hasRemovedZalouserFingerprint(target))
    ) {
      return [];
    }
    return [
      {
        checkId: CHECK_ID,
        severity: "warning",
        message: `Removed zalouser plugin credential state remains at ${target}.`,
        path: target,
        fixHint: "Run `openclaw doctor --fix` to remove the stale plugin credential state.",
      },
    ];
  },
  async repair(ctx) {
    const target = resolveRemovedZalouserStateDir();
    if (!(await hasRemovedZalouserFingerprint(target))) {
      return {
        status: "skipped",
        reason: "removed zalouser plugin credential state is absent",
        changes: [],
      };
    }
    const dryRun = ctx.dryRun === true;
    const effects = [repairEffect(target, dryRun)];
    if (dryRun) {
      return {
        changes: [`Would remove removed zalouser plugin credential state at ${target}.`],
        effects,
      };
    }
    await rm(target, { force: true, recursive: true });
    return { changes: [`Removed removed zalouser plugin credential state at ${target}.`], effects };
  },
};
