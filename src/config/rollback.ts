import fs from "node:fs";
import { resolveConfigPath, resolveStateDir } from "./paths.js";

export type RollbackResult = { ok: true; backupPath: string } | { ok: false; error: string };

/**
 * Rollback config to the most recent backup (.bak file).
 * Used when preflight check fails after config change.
 */
export async function rollbackToBackupConfig(
  configPath?: string,
  ioFs: typeof fs.promises = fs.promises,
): Promise<RollbackResult> {
  const resolvedPath = configPath ?? resolveConfigPath(process.env, resolveStateDir());
  const backupPath = `${resolvedPath}.bak`;

  try {
    await ioFs.access(backupPath);
  } catch {
    return { ok: false, error: "no backup file found" };
  }

  try {
    await ioFs.copyFile(backupPath, resolvedPath);
    return { ok: true, backupPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
