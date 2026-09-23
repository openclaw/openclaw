// Coordinates plugin install flow decisions from source detection through target preparation.
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import {
  type ArchiveExtractLimits,
  type ArchiveLogger,
  extractArchive,
  resolvePackedRootDir,
} from "./archive.js";
import { pathExists } from "./fs-safe.js";
import { resolveInstallWorkTimeoutMs } from "./install-mode-options.js";
import { withInstallActivity, type InstallActivityObserver } from "./install-progress.js";
import { withInstallWorkspace } from "./install-source-utils.js";

// Install-flow helpers validate local install paths and unpack archives inside
// temporary workspaces before handing the resolved package root to callers.
type ExistingInstallPathResult =
  | {
      ok: true;
      resolvedPath: string;
      stat: Stats;
    }
  | {
      ok: false;
      error: string;
    };

/** Resolve and stat a user-provided install path. */
export async function resolveExistingInstallPath(
  inputPath: string,
): Promise<ExistingInstallPathResult> {
  const resolvedPath = resolveUserPath(inputPath);
  if (!(await pathExists(resolvedPath))) {
    return { ok: false, error: `path not found: ${resolvedPath}` };
  }
  const stat = await fs.stat(resolvedPath);
  return { ok: true, resolvedPath, stat };
}

/** Extract an archive to a temp dir and run work against the detected package root. */
export async function withExtractedArchiveRoot<TResult extends { ok: boolean }>(params: {
  archivePath: string;
  tempDirPrefix: string;
  timeoutMs: number;
  workTimeoutMs?: number | null;
  logger?: ArchiveLogger & InstallActivityObserver;
  limits?: ArchiveExtractLimits;
  rootMarkers?: readonly string[];
  onExtracted: (rootDir: string) => Promise<TResult>;
}): Promise<TResult | { ok: false; error: string }> {
  return await withInstallWorkspace(params.tempDirPrefix, async (tmpDir) => {
    const extractDir = path.join(tmpDir, "extract");
    await fs.mkdir(extractDir, { recursive: true });

    params.logger?.info?.(`Extracting ${params.archivePath}…`);
    try {
      await withInstallActivity(params.logger, "extract", () =>
        extractArchive({
          archivePath: params.archivePath,
          destDir: extractDir,
          // fs-safe uses zero for an extraction without an elapsed deadline.
          timeoutMs: resolveInstallWorkTimeoutMs(params.workTimeoutMs, params.timeoutMs) ?? 0,
          logger: params.logger,
          limits: params.limits,
          durable: false,
        }),
      );
    } catch (err) {
      return { ok: false, error: `failed to extract archive: ${String(err)}` };
    }

    let rootDir;
    try {
      rootDir = await resolvePackedRootDir(extractDir, {
        rootMarkers: params.rootMarkers ? [...params.rootMarkers] : undefined,
      });
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    return await params.onExtracted(rootDir);
  });
}
