// Marks retained managed npm package trees that should stay importable but not recoverable.
import fs from "node:fs";
import path from "node:path";
import { safePathSegmentHashed } from "../infra/install-safe-path.js";

export const RETAINED_MANAGED_NPM_INSTALL_MARKER = ".openclaw-retained-npm-install.json";
const RETAINED_MANAGED_NPM_INSTALL_MARKER_DIR = ".openclaw-retained-npm-installs";

export function resolveRetainedManagedNpmInstallPackageInfo(packageDir: string): {
  packageName: string;
  projectRoot: string;
  markerPath: string;
} | null {
  const resolvedPackageDir = path.resolve(packageDir);
  const packageBase = path.basename(resolvedPackageDir);
  const parentDir = path.dirname(resolvedPackageDir);
  const parentBase = path.basename(parentDir);
  const scopedPackage = parentBase.startsWith("@");
  const nodeModulesRoot = scopedPackage ? path.dirname(parentDir) : parentDir;
  if (path.basename(nodeModulesRoot) !== "node_modules") {
    return null;
  }
  const packageName = scopedPackage ? `${parentBase}/${packageBase}` : packageBase;
  if (!packageBase || packageBase === "." || !packageName.trim()) {
    return null;
  }
  const projectRoot = path.dirname(nodeModulesRoot);
  return {
    packageName,
    projectRoot,
    markerPath: path.join(
      projectRoot,
      RETAINED_MANAGED_NPM_INSTALL_MARKER_DIR,
      `${safePathSegmentHashed(packageName)}.json`,
    ),
  };
}

export function resolveRetainedManagedNpmInstallMarkerPath(packageDir: string): string {
  const info = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  if (!info) {
    throw new Error("retained npm install marker requires a node_modules package directory");
  }
  return info.markerPath;
}

export function hasRetainedManagedNpmInstallMarker(packageDir: string): boolean {
  const info = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  return info ? fs.existsSync(info.markerPath) : false;
}

export async function clearRetainedManagedNpmInstallMarker(packageDir: string): Promise<boolean> {
  const info = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  if (!info) {
    return false;
  }
  try {
    await fs.promises.rm(info.markerPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  try {
    await fs.promises.rmdir(path.dirname(info.markerPath));
  } catch {
    // Best effort: keep the OpenClaw-owned marker directory if it is not empty.
  }
  return true;
}

export async function markRetainedManagedNpmInstall(params: {
  packageDir: string;
  pluginId: string;
  retainedAt?: string;
  reason: string;
}): Promise<boolean> {
  const info = resolveRetainedManagedNpmInstallPackageInfo(params.packageDir);
  if (!info) {
    return false;
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(params.packageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    return false;
  }
  await fs.promises.mkdir(path.dirname(info.markerPath), { recursive: true });
  await fs.promises.writeFile(
    info.markerPath,
    `${JSON.stringify(
      {
        version: 1,
        pluginId: params.pluginId,
        retainedAt: params.retainedAt ?? new Date().toISOString(),
        reason: params.reason,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return true;
}
