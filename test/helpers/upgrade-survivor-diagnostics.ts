import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const UPGRADE_SURVIVOR_DIAGNOSTICS_PATH = "scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";

export function copySurvivorCaptureClosure(workDir: string) {
  for (const source of [
    "scripts/e2e/lib/openclaw-state-paths.mjs",
    "scripts/e2e/lib/plugin-index-sqlite.mjs",
    "scripts/e2e/lib/env-limits.mjs",
    "scripts/e2e/lib/text-file-utils.mjs",
    UPGRADE_SURVIVOR_DIAGNOSTICS_PATH,
    "scripts/e2e/lib/upgrade-survivor/backup-rollback-summary.mjs",
    "scripts/lib/release-version.mjs",
  ]) {
    const destination = join(workDir, source);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  return join(workDir, UPGRADE_SURVIVOR_DIAGNOSTICS_PATH);
}
