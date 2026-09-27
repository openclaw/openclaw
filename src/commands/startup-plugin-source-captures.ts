import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveStateDir } from "../config/state-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import {
  resolvePluginSourceCaptureFallbackPrefix,
  resolvePluginSourceCapturesDirectory,
} from "../plugins/plugin-source-capture-path.js";
import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";

async function hasCaptureDirectories(stateDir: string, directory: string): Promise<boolean> {
  try {
    await fs.access(directory);
    return true;
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  const prefix = resolvePluginSourceCaptureFallbackPrefix(stateDir);
  try {
    for await (const entry of await fs.opendir(tmpdir())) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        return true;
      }
    }
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  return false;
}

/** Reclaim retired payloads before runtime loading, using the same receipt owner as Doctor. */
export async function cleanupStartupPluginSourceCaptures(env = process.env): Promise<void> {
  if (isArtifactPreservingStateRead()) {
    return;
  }
  const stateDir = resolveStateDir(env);
  const directory = resolvePluginSourceCapturesDirectory(stateDir);
  try {
    if (!(await hasCaptureDirectories(stateDir, directory))) {
      return;
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
