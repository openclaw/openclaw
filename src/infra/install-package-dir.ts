import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { fileExists } from "./archive.js";

/**
 * Files that should be preserved from the previous installation directory
 * when updating a package.  These are user-created configuration files that
 * are not part of the distributed package itself.
 */
const PRESERVED_FILES = [".env"];

export async function installPackageDir(params: {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void };
  copyErrorPrefix: string;
  hasDeps: boolean;
  depsLogMessage: string;
  afterCopy?: () => void | Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  params.logger?.info?.(`Installing to ${params.targetDir}…`);
  let backupDir: string | null = null;
  if (params.mode === "update" && (await fileExists(params.targetDir))) {
    backupDir = `${params.targetDir}.backup-${Date.now()}`;
    await fs.rename(params.targetDir, backupDir);
  }

  const rollback = async () => {
    if (!backupDir) {
      return;
    }
    await fs.rm(params.targetDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rename(backupDir, params.targetDir).catch(() => undefined);
  };

  try {
    await fs.cp(params.sourceDir, params.targetDir, { recursive: true });
  } catch (err) {
    await rollback();
    return { ok: false, error: `${params.copyErrorPrefix}: ${String(err)}` };
  }

  try {
    await params.afterCopy?.();
  } catch (err) {
    await rollback();
    return { ok: false, error: `post-copy validation failed: ${String(err)}` };
  }

  if (params.hasDeps) {
    params.logger?.info?.(params.depsLogMessage);
    const npmRes = await runCommandWithTimeout(
      ["npm", "install", "--omit=dev", "--silent", "--ignore-scripts"],
      {
        timeoutMs: Math.max(params.timeoutMs, 300_000),
        cwd: params.targetDir,
      },
    );
    if (npmRes.code !== 0) {
      await rollback();
      return {
        ok: false,
        error: `npm install failed: ${npmRes.stderr.trim() || npmRes.stdout.trim()}`,
      };
    }
  }

  if (backupDir) {
    for (const file of PRESERVED_FILES) {
      const backupFile = path.join(backupDir, file);
      const targetFile = path.join(params.targetDir, file);
      try {
        await fs.copyFile(backupFile, targetFile);
        params.logger?.info?.(`Preserved ${file} from previous installation.`);
      } catch (err) {
        // Ignore if file didn't exist in backup, but log other errors
        if ((err as { code?: string }).code !== "ENOENT") {
          params.logger?.info?.(`Failed to preserve ${file}: ${String(err)}`);
        }
      }
    }

    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { ok: true };
}
