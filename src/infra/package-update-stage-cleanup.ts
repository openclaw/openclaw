import fs from "node:fs/promises";
import path from "node:path";
import { ignoreMissingPath } from "./errno.js";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import { isPathInside } from "./fs-safe.js";
import { discardPendingPackageLifecycle } from "./package-lifecycle.js";
import { removePackageUpdatePath } from "./package-update-filesystem.js";
import type { StagedPackageInstall } from "./package-update-swap-contract.js";
import type { UpdateStepResult } from "./update-step-result.js";

class PackageStageRemovalError extends Error {}

async function cleanupStagedPackageInstall(stage: StagedPackageInstall): Promise<void> {
  const discard = async () => {
    if (!(await removePackageUpdatePath(stage.prefix))) {
      throw new PackageStageRemovalError(
        `Unable to remove discarded package stage ${stage.prefix}`,
      );
    }
    if (stage.native) {
      await removePackageUpdatePath(stage.native.binDir);
    }
  };
  const prefix = (await fs.realpath(stage.prefix).catch(ignoreMissingPath)) ?? null;
  const candidates = [stage.packageRoot];
  if (prefix && stage.native && stage.installTarget.pnpmIsolated) {
    // Activation follows active hash links only. Disposal also removes unlinked
    // install directories left by a failed pnpm 11+ invocation, without requiring
    // a completed manifest or lockfile. Discovery errors must preserve the stage.
    const entries = await fs
      .readdir(stage.native.globalRoot, { withFileTypes: true })
      .catch((error: unknown) => ignoreMissingPath(error) ?? []);
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        candidates.push(
          path.join(
            stage.native.globalRoot,
            entry.name,
            "node_modules",
            path.basename(stage.packageRoot),
          ),
        );
      }
    }
  }
  const packageRoots = new Set<string>();
  if (prefix) {
    for (const candidate of candidates) {
      const packageRoot = await fs.realpath(candidate).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
          return null;
        }
        throw error;
      });
      if (
        packageRoot &&
        isPathInside(prefix, packageRoot) &&
        (await fs.stat(packageRoot)).isDirectory()
      ) {
        packageRoots.add(packageRoot);
      }
    }
  }
  // Missing/activated roots need no admission. Removing an external source link
  // does not remove its payload or authorize changing its lifecycle markers.
  await discardPendingPackageLifecycle({ packageRoots: [...packageRoots], discard });
}

/** Dispose only after pending work is retired under its lifecycle generation. */
export async function discardPackageUpdateStage(params: {
  stage: StagedPackageInstall;
  committed: boolean;
}): Promise<UpdateStepResult | null> {
  try {
    await cleanupStagedPackageInstall(params.stage);
    return null;
  } catch (error) {
    // Only a refused disposable-prefix removal after a verified swap is harmless.
    // Discovery, lifecycle ownership and release failures remain strict.
    if (params.committed && error instanceof PackageStageRemovalError) {
      const message = `${error.message}. Installation verification succeeded; inspect the retained stage before removing it manually.`;
      return {
        name: "package-stage-cleanup",
        command: `discard ${params.stage.prefix}`,
        cwd: params.stage.prefix,
        durationMs: 0,
        exitCode: 1,
        stderrTail: message,
        advisory: { kind: "recoverable-maintenance", message },
      };
    }
    return {
      name: `${params.stage.installTarget.manager}-package-lifecycle`,
      command: `discard ${params.stage.packageRoot}`,
      cwd: params.stage.packageRoot,
      durationMs: 0,
      exitCode: 1,
      stderrTail: formatErrorMessage(error),
    };
  }
}
