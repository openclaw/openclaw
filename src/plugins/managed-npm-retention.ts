// Marks retained managed npm package trees that should stay importable but not recoverable.
import fs from "node:fs";
import path from "node:path";
import { safePathSegmentHashed } from "../infra/install-safe-path.js";
import { resolveDefaultPluginNpmDir, resolvePluginNpmProjectsDir } from "./install-paths.js";
import { listManagedPluginNpmProjectRootsSync } from "./npm-project-roots.js";

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

function isPathEqualOrInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export async function cleanupRetainedManagedNpmInstallGenerations(
  params: {
    activeInstallPaths?: Iterable<string>;
    env?: NodeJS.ProcessEnv;
    npmDir?: string;
    onError?: (error: unknown, projectRoot: string) => void;
  } = {},
): Promise<number> {
  // Callers run this after the previous gateway server has closed and before
  // the next one loads plugins, so retired module graphs no longer need these trees.
  const npmDir = params.npmDir ?? resolveDefaultPluginNpmDir(params.env);
  const projectsDir = resolvePluginNpmProjectsDir(npmDir);
  const activeInstallPaths = Array.from(params.activeInstallPaths ?? [], (installPath) =>
    path.resolve(installPath),
  );
  let removed = 0;
  for (const projectRoot of listManagedPluginNpmProjectRootsSync(npmDir)) {
    const markerDir = path.join(projectRoot, RETAINED_MANAGED_NPM_INSTALL_MARKER_DIR);
    let markerEntries: fs.Dirent[];
    try {
      markerEntries = fs
        .readdirSync(markerDir, { withFileTypes: true })
        .filter((entry) => entry.isFile());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      params.onError?.(error, projectRoot);
      continue;
    }
    if (
      markerEntries.length === 0 ||
      !isPathEqualOrInside(projectsDir, projectRoot) ||
      activeInstallPaths.some((installPath) => isPathEqualOrInside(projectRoot, installPath))
    ) {
      continue;
    }
    try {
      await fs.promises.rm(projectRoot, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      params.onError?.(error, projectRoot);
    }
  }
  return removed;
}
