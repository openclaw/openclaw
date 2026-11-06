// Remembers a Git checkout whose replacement committed but whose activation
// did not finish. The previous generation can still be running, so the install
// must not delete it in that failure. Reload and Gateway startup remove it
// once no loaded plugin or install record still uses the path.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { visitConfigValueTree } from "../config/value-tree.js";
import { ignoreMissingPath } from "../infra/errno.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { isPathStrictlyInside } from "../infra/path-guards.js";
import { normalizePluginId } from "./config-state.js";
import { resolveDefaultPluginGitDir } from "./install-paths.js";
import {
  applyPluginUninstallDirectoryRemoval,
  type PluginUninstallDirectoryRemoval,
} from "./uninstall.js";

const RETIRED_GIT_INSTALL_MARKER_DIR = ".openclaw-retired-git-installs";

type RetiredGitInstallMarker = {
  version: 1;
  pluginId: string;
  target: string;
  parentDir: string;
  dev: string;
  ino: string;
};

export function retiredGitInstallMarkerDirectory(env?: NodeJS.ProcessEnv): string {
  return path.join(resolveDefaultPluginGitDir(env), RETIRED_GIT_INSTALL_MARKER_DIR);
}

/** True when a published Git retirement still needs the cleanup owner. */
export async function hasRetiredGitPluginInstallCandidates(
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  let names: string[] = [];
  try {
    names = await fs.readdir(retiredGitInstallMarkerDirectory(env));
  } catch (error: unknown) {
    ignoreMissingPath(error);
  }
  return names.some((name) => name.endsWith(".json"));
}

/** Absolute and home-relative config values that may still name a retired checkout. */
export function collectConfiguredPluginReferencePaths(configs: Iterable<unknown>): string[] {
  const configuredPaths: string[] = [];
  visitConfigValueTree([...configs], (value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (path.isAbsolute(trimmed) || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
        configuredPaths.push(resolveUserPath(trimmed));
      }
    }
    return true;
  });
  return configuredPaths;
}

function markerPathFor(target: string, env?: NodeJS.ProcessEnv): string {
  const digest = createHash("sha256").update(path.resolve(target)).digest("hex");
  return path.join(retiredGitInstallMarkerDirectory(env), `${digest}.json`);
}

function pathsOverlap(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return (
    resolvedLeft === resolvedRight ||
    isPathStrictlyInside(resolvedLeft, resolvedRight) ||
    isPathStrictlyInside(resolvedRight, resolvedLeft)
  );
}

function managedGitCheckout(
  removal: PluginUninstallDirectoryRemoval,
  env?: NodeJS.ProcessEnv,
): { target: string; parentDir: string } | null {
  if (removal.cleanup?.kind !== "git") {
    return null;
  }
  const gitDir = path.resolve(resolveDefaultPluginGitDir(env));
  const target = path.resolve(removal.target);
  const parentDir = path.resolve(removal.cleanup.parentDir);
  if (
    path.dirname(target) !== parentDir ||
    !isPathStrictlyInside(gitDir, target) ||
    !isPathStrictlyInside(gitDir, parentDir)
  ) {
    return null;
  }
  return { target, parentDir };
}

/** Record the previous Git checkout before activation, which may still fail. */
export async function rememberRetiredGitPluginInstall(params: {
  pluginId: string;
  removal: PluginUninstallDirectoryRemoval;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const checkout = managedGitCheckout(params.removal, params.env);
  if (!checkout) {
    return false;
  }
  const stat = await fs.lstat(checkout.target).catch((error: unknown) => {
    ignoreMissingPath(error);
    return null;
  });
  if (!stat?.isDirectory()) {
    return false;
  }
  const marker: RetiredGitInstallMarker = {
    version: 1,
    pluginId: normalizePluginId(params.pluginId),
    target: checkout.target,
    parentDir: checkout.parentDir,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
  };
  const markerPath = markerPathFor(checkout.target, params.env);
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, "utf8");
  await fs.rename(temporaryPath, markerPath);
  return true;
}

export async function forgetRetiredGitPluginInstall(params: {
  target: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await fs.rm(markerPathFor(params.target, params.env), { force: true });
  await fs.rmdir(retiredGitInstallMarkerDirectory(params.env)).catch(() => undefined);
}

export function gitInstallProtectPaths(sources: {
  installPaths?: Iterable<string | undefined>;
  plugins?: Iterable<{ rootDir?: string; source?: string }>;
  extra?: Iterable<string | undefined>;
}): string[] {
  const paths: string[] = [];
  for (const installPath of sources.installPaths ?? []) {
    if (installPath?.trim()) {
      paths.push(installPath);
    }
  }
  for (const plugin of sources.plugins ?? []) {
    if (plugin.rootDir?.trim()) {
      paths.push(plugin.rootDir);
    }
    if (plugin.source?.trim()) {
      paths.push(plugin.source);
    }
  }
  for (const extra of sources.extra ?? []) {
    if (extra?.trim()) {
      paths.push(extra);
    }
  }
  return paths;
}

function readMarker(contents: string): RetiredGitInstallMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const { version, pluginId, target, parentDir, dev, ino } = parsed;
  if (
    version !== 1 ||
    typeof pluginId !== "string" ||
    typeof target !== "string" ||
    typeof parentDir !== "string" ||
    typeof dev !== "string" ||
    typeof ino !== "string"
  ) {
    return null;
  }
  return { version, pluginId, target, parentDir, dev, ino };
}

/** Remove retired Git checkouts that are no longer loaded or configured. */
export async function cleanupRetiredGitPluginInstalls(params: {
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  installOwners?: readonly string[];
  protectPaths: readonly string[];
  assertCurrent?: () => void | Promise<void>;
  beforePersistentApply?: () => void;
}): Promise<{ removed: number; warnings: string[] }> {
  const warnings: string[] = [];
  const markerDir = retiredGitInstallMarkerDirectory(params.env);
  let names: string[] = [];
  try {
    names = await fs.readdir(markerDir);
  } catch (error: unknown) {
    ignoreMissingPath(error);
  }
  const wanted = new Set<string>();
  const scoped = params.pluginIds !== undefined || params.installOwners !== undefined;
  for (const pluginId of [...(params.pluginIds ?? []), ...(params.installOwners ?? [])]) {
    wanted.add(normalizePluginId(pluginId));
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    await params.assertCurrent?.();
    const markerPath = path.join(markerDir, name);
    const marker = readMarker(await fs.readFile(markerPath, "utf8").catch(() => ""));
    if (!marker) {
      await fs.rm(markerPath, { force: true });
      continue;
    }
    if (scoped && !wanted.has(normalizePluginId(marker.pluginId))) {
      continue;
    }
    const checkout = managedGitCheckout(
      {
        target: marker.target,
        cleanup: { kind: "git", parentDir: marker.parentDir },
      },
      params.env,
    );
    if (!checkout || path.resolve(marker.target) !== checkout.target) {
      await fs.rm(markerPath, { force: true });
      continue;
    }
    if (params.protectPaths.some((protectedPath) => pathsOverlap(protectedPath, checkout.target))) {
      continue;
    }
    const stat = await fs.lstat(checkout.target).catch((error: unknown) => {
      ignoreMissingPath(error);
      return null;
    });
    if (!stat) {
      await fs.rm(markerPath, { force: true });
      await fs.rmdir(checkout.parentDir).catch(() => undefined);
      continue;
    }
    if (
      !stat.isDirectory() ||
      stat.dev.toString() !== marker.dev ||
      stat.ino.toString() !== marker.ino
    ) {
      await fs.rm(markerPath, { force: true });
      continue;
    }
    await params.assertCurrent?.();
    const result = await applyPluginUninstallDirectoryRemoval(
      {
        target: checkout.target,
        cleanup: { kind: "git", parentDir: checkout.parentDir },
      },
      params.beforePersistentApply,
    );
    warnings.push(...result.warnings);
    if (result.directoryRemoved) {
      removed += 1;
      await fs.rm(markerPath, { force: true });
    }
  }
  await fs.rmdir(markerDir).catch(() => undefined);
  return { removed, warnings };
}
