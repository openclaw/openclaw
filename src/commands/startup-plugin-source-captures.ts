import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";

/** Reclaim retired payloads before runtime loading, using the same receipt owner as Doctor. */
export async function cleanupStartupPluginSourceCaptures(env = process.env): Promise<void> {
  if (isArtifactPreservingStateRead()) {
    return;
  }
  const stateDir = resolveStateDir(env);
  const directory = path.join(stateDir, "tmp", "plugin-captures");
  try {
    try {
      await fs.access(directory);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    const [{ withDoctorSqliteMaintenanceLock }, { pruneUnreferencedPluginNativeCaptures }] =
      await Promise.all([
        import("./doctor-sqlite-maintenance-lock.js"),
        import("../plugins/plugin-source-capture-report.js"),
      ]);
    const result = await withDoctorSqliteMaintenanceLock({
      env,
      operation: "plugin source cleanup",
      protectedPaths: [directory],
      run: (authority) =>
        pruneUnreferencedPluginNativeCaptures(stateDir, () => authority.assertCurrent(), env, {
          startup: true,
        }),
    });
    if (result.warnings.length) {
      process.emitWarning(`Plugin source capture startup cleanup: ${result.warnings.join("; ")}`);
    }
  } catch (error) {
    process.emitWarning(`Plugin source capture startup cleanup deferred: ${String(error)}`);
  }
}
