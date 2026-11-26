// Owns peer file inspection and mutation after the install ledger admits a package.
import type { BigIntStats, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode, ignoreMissingPath } from "../infra/errno.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { sameFsObject } from "../infra/path-case.js";

export type PluginPeerLinkLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type OpenClawPeerLinkResult = "linked" | "skipped" | "unchanged";

export async function readSafePackageManifest(
  packageDir: string,
): Promise<Record<string, unknown> | null> {
  const result = readRootJsonObjectSync({
    rootDir: packageDir,
    relativePath: "package.json",
    boundaryLabel: "installed plugin package directory",
  });
  if (!result.ok) {
    if (result.reason === "open" && hasErrnoCode(result.failure.error, "ENOENT")) {
      return null;
    }
    if (result.reason === "parse") {
      throw new SyntaxError(result.error);
    }
    if (result.reason === "open" && result.failure.error instanceof Error) {
      throw result.failure.error;
    }
    throw new Error(
      `Could not safely read package.json from ${packageDir}: ${
        result.reason === "open" ? result.failure.reason : result.error
      }`,
    );
  }
  return result.value;
}

export async function safeRealpath(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return null;
  }
}

async function ensureRealNodeModulesDir(params: {
  installedDir: string;
  logger: PluginPeerLinkLogger;
  beforePersistentApply?: () => void;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<string | null> {
  const nodeModulesDir = path.join(params.installedDir, "node_modules");
  let existing: Stats | undefined;
  try {
    existing = await fs.lstat(nodeModulesDir);
  } catch (error) {
    ignoreMissingPath(error);
  }
  if (!existing) {
    await params.beforePersistentEffect?.();
    params.beforePersistentApply?.();
    await fs.mkdir(nodeModulesDir, { recursive: true });
    existing = await fs.lstat(nodeModulesDir);
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    params.logger.warn?.(
      `Skipping openclaw peerDependency link because ${nodeModulesDir} is not a real directory.`,
    );
    return null;
  }
  return nodeModulesDir;
}

export async function linkOpenClawPeerDependency(params: {
  hostRoot: string;
  installedDir: string;
  logger: PluginPeerLinkLogger;
  beforePersistentApply?: () => void;
  beforePersistentEffect?: () => void | Promise<void>;
  /** Git registry repair may only replace an existing link to a release of this installation. */
  gitReleasePrefix?: string;
}): Promise<OpenClawPeerLinkResult> {
  const modulesPath = path.join(params.installedDir, "node_modules");
  const nodeModulesDir = params.gitReleasePrefix
    ? modulesPath
    : await ensureRealNodeModulesDir(params);
  if (
    !nodeModulesDir ||
    (params.gitReleasePrefix && (await safeRealpath(nodeModulesDir)) !== nodeModulesDir)
  ) {
    return "skipped";
  }

  const linkPath = path.join(nodeModulesDir, "openclaw");
  const expectedTarget = (await safeRealpath(params.hostRoot)) ?? params.hostRoot;
  const currentTarget = await safeRealpath(linkPath);
  // Explicit install/repair always rebinds a relocated copy to this runtime, even for the same build.
  if (currentTarget === expectedTarget) {
    return "unchanged";
  }

  const warn = (error: unknown): "skipped" => {
    params.beforePersistentApply?.();
    params.logger.warn?.(`Failed to symlink peerDependency "openclaw": ${String(error)}`);
    return "skipped";
  };
  let existing: BigIntStats | null;
  let previousTarget = currentTarget;
  try {
    existing = await fs.lstat(linkPath, { bigint: true }).catch((error: unknown) => {
      ignoreMissingPath(error);
      return null;
    });
    if (existing?.isSymbolicLink()) {
      previousTarget = path.resolve(nodeModulesDir, await fs.readlink(linkPath));
    }
    // A repair interrupted after unlink can retry the exclusive symlink creation.
    if (
      params.gitReleasePrefix &&
      existing &&
      (!existing.isSymbolicLink() ||
        !previousTarget ||
        !isReleaseHostPath(
          (await safeRealpath(previousTarget)) ?? previousTarget,
          params.gitReleasePrefix,
        ))
    ) {
      return "skipped";
    }
    if (
      existing &&
      !existing.isSymbolicLink() &&
      (!existing.isDirectory() || (await readPackageName(linkPath)) !== "openclaw")
    ) {
      params.logger.warn?.(
        `Skipping openclaw peerDependency link because ${linkPath} already exists and is not a symlink.`,
      );
      return "skipped";
    }
  } catch (error) {
    return warn(error);
  }
  // Admit each effect through its initiating owner before submitting filesystem work.
  if (existing) {
    await params.beforePersistentEffect?.();
    if (params.gitReleasePrefix) {
      const current = await fs.lstat(linkPath, { bigint: true }).catch(ignoreMissingPath);
      if (
        !current?.isSymbolicLink() ||
        current.ino === 0n ||
        !sameFsObject(existing, current) ||
        (await safeRealpath(nodeModulesDir)) !== nodeModulesDir
      ) {
        return "skipped";
      }
    }
    params.beforePersistentApply?.();
    try {
      if (existing.isSymbolicLink()) {
        await fs.unlink(linkPath);
      } else {
        await fs.rm(linkPath, { recursive: true, force: true });
      }
    } catch (error) {
      return warn(error);
    }
  }
  await params.beforePersistentEffect?.();
  if (params.gitReleasePrefix && (await safeRealpath(nodeModulesDir)) !== nodeModulesDir) {
    return "skipped";
  }
  params.beforePersistentApply?.();
  try {
    await fs.symlink(
      params.gitReleasePrefix ? expectedTarget : params.hostRoot,
      linkPath,
      "junction",
    );
    if (previousTarget) {
      params.logger.warn?.(
        `Repaired OpenClaw host link at ${linkPath}: ${previousTarget} -> ${expectedTarget}`,
      );
    }
    params.logger.info?.(`Linked peerDependency "openclaw" -> ${params.hostRoot}`);
    return "linked";
  } catch (error) {
    return warn(error);
  }
}

async function readPackageName(packageDir: string): Promise<string | undefined> {
  const manifest = await readSafePackageManifest(packageDir);
  return typeof manifest?.name === "string" ? manifest.name : undefined;
}

function isReleaseHostPath(root: string, releasePrefix: string): boolean {
  const [releasesDir, generation, ...packagePath] = path
    .relative(releasePrefix, root)
    .split(path.sep);
  const relativePackage = packagePath.join(path.sep);
  return (
    releasesDir === "releases" &&
    Boolean(generation && !generation.startsWith(".")) &&
    (relativePackage === "openclaw" ||
      relativePackage === path.join("lib", "node_modules", "openclaw"))
  );
}
