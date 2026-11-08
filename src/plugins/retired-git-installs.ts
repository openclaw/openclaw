// Remembers a Git checkout whose replacement committed but whose activation
// did not finish. The previous generation can still be running, so the install
// must not delete it in that failure. Reload and Gateway startup remove it
// once no loaded plugin or install record still uses the path.
import fs from "node:fs/promises";
import path from "node:path";
import { visitConfigValueTree } from "../config/value-tree.js";
import { ignoreMissingPath } from "../infra/errno.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { isPathStrictlyInside } from "../infra/path-guards.js";
import { readConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { normalizePluginId } from "./config-state.js";
import { resolveDefaultPluginGitDir } from "./install-paths.js";
import {
  RETIRED_GIT_INSTALLS_STATE_KEY,
  retiredGitInstallMarkerFrom as markerFrom,
  type RetiredGitInstallMarker,
  type RetiredGitInstallStateReplacement,
} from "./retired-git-installs.kernel.js";
import {
  applyPluginUninstallDirectoryRemoval,
  type PluginUninstallDirectoryRemoval,
} from "./uninstall.js";

export { RETIRED_GIT_INSTALLS_STATE_KEY };

type GatewayStartupPluginProtection = {
  configs: readonly unknown[];
  paths: readonly string[];
};

// Reload runs in this Gateway process and does not receive the boot closure
// that idle cleanup already has. Remember those paths until process exit.
let startupProtection: GatewayStartupPluginProtection = { configs: [], paths: [] };

export function rememberGatewayStartupPluginProtection(
  protection: GatewayStartupPluginProtection,
): void {
  startupProtection = {
    configs: protection.configs.filter((config) => config != null),
    paths: [...protection.paths],
  };
}

export function currentGatewayStartupPluginProtection(): GatewayStartupPluginProtection {
  return startupProtection;
}

function stateOptions(env?: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return env ? { env } : {};
}

async function readRetiredGitInstallState(
  env?: NodeJS.ProcessEnv,
): Promise<{ records: unknown[] | undefined } | { unreadable: string }> {
  try {
    const value = await readConfigMachineStateAsync<unknown>(
      RETIRED_GIT_INSTALLS_STATE_KEY,
      stateOptions(env),
    );
    if (value === undefined) {
      return { records: undefined };
    }
    if (!Array.isArray(value)) {
      return { unreadable: "retired git install record is unreadable" };
    }
    return { records: value };
  } catch (error: unknown) {
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
}

async function replaceRetiredGitInstallState(
  env: NodeJS.ProcessEnv | undefined,
  replacement: RetiredGitInstallStateReplacement,
): Promise<void> {
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  await runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext(stateOptions(env)),
    (scope) => scope.execute({ type: "retiredGitInstalls.replace", input: replacement }),
  );
}

/** True when a published Git retirement still needs the cleanup owner. */
export async function hasRetiredGitPluginInstallCandidates(
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const read = await readRetiredGitInstallState(env);
  if ("unreadable" in read) {
    return true;
  }
  return (read.records?.length ?? 0) > 0;
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
  await replaceRetiredGitInstallState(params.env, { action: "remember", marker });
  return true;
}

export async function forgetRetiredGitPluginInstall(params: {
  target: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await replaceRetiredGitInstallState(params.env, {
    action: "forget",
    targets: [path.resolve(params.target)],
    dropUnreadable: false,
  });
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
  const read = await readRetiredGitInstallState(params.env);
  // A missing row is the only absence. A read failure must not delete the obligation.
  if ("unreadable" in read) {
    return { removed: 0, warnings: [read.unreadable] };
  }
  const records = read.records ?? [];
  const wanted = new Set<string>();
  const scoped = params.pluginIds !== undefined || params.installOwners !== undefined;
  for (const pluginId of [...(params.pluginIds ?? []), ...(params.installOwners ?? [])]) {
    wanted.add(normalizePluginId(pluginId));
  }
  const finished = new Set<string>();
  let removed = 0;
  for (const entry of records) {
    await params.assertCurrent?.();
    const marker = markerFrom(entry);
    if (!marker) {
      continue;
    }
    const target = path.resolve(marker.target);
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
      finished.add(target);
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
      // The checkout is already gone. Recheck authority before removing its
      // empty parent; a revocation must escape the filesystem-error handler.
      await params.assertCurrent?.();
      params.beforePersistentApply?.();
      await fs.rmdir(checkout.parentDir).catch(() => undefined);
      finished.add(target);
      continue;
    }
    if (
      !stat.isDirectory() ||
      stat.dev.toString() !== marker.dev ||
      stat.ino.toString() !== marker.ino
    ) {
      finished.add(target);
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
      finished.add(target);
    }
  }
  if (finished.size > 0 || records.some((entry) => markerFrom(entry) === null)) {
    await replaceRetiredGitInstallState(params.env, {
      action: "forget",
      targets: [...finished],
      dropUnreadable: true,
    });
  }
  return { removed, warnings };
}
