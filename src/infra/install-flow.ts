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

export type ExtractedArchiveVerification<TFailure extends { ok: false; error: string }> = {
  limits: ArchiveExtractLimits;
  verify: (extractDir: string) => Promise<TFailure | null>;
  onExtractionError: (error: unknown) => TFailure;
};

/** Extract an archive to a temp dir and run work against the detected package root. */
export async function withExtractedArchiveRoot<
  TResult extends { ok: boolean },
  TFailure extends { ok: false; error: string } = never,
>(params: {
  archivePath: string;
  tempDirPrefix: string;
  timeoutMs: number;
  workTimeoutMs?: number | null;
  logger?: ArchiveLogger & InstallActivityObserver;
  limits?: ArchiveExtractLimits;
  verification?: ExtractedArchiveVerification<TFailure>;
  rootMarkers?: readonly string[];
  onExtracted: (rootDir: string) => Promise<TResult>;
}): Promise<TResult | TFailure | { ok: false; error: string }> {
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
          limits: params.verification?.limits ?? params.limits,
          durable: false,
        }),
      );
    } catch (err) {
      if (params.verification) {
        return params.verification.onExtractionError(err);
      }
      return { ok: false, error: `failed to extract archive: ${String(err)}` };
    }

    // Verify the entire archive before root selection can hide sibling files.
    const verificationFailure = await params.verification?.verify(extractDir);
    if (verificationFailure) {
      return verificationFailure;
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
