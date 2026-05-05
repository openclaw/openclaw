import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";

type PluginPeerLinkLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * Symlink the host openclaw package for plugins that declare it as a peer.
 * Plugin package managers still own third-party dependencies; this only wires
 * the host SDK package into the plugin-local Node graph.
 */
export async function linkOpenClawPeerDependencies(params: {
  installedDir: string;
  peerDependencies: Record<string, string>;
  logger: PluginPeerLinkLogger;
}): Promise<void> {
  const peers = Object.keys(params.peerDependencies).filter((name) => name === "openclaw");
  if (peers.length === 0) {
    return;
  }

  const hostRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  });
  if (!hostRoot) {
    params.logger.warn?.(
      "Could not locate openclaw package root to symlink peerDependencies; plugin may fail to resolve openclaw at runtime.",
    );
    return;
  }

  const nodeModulesDir = path.join(params.installedDir, "node_modules");
  await fs.mkdir(nodeModulesDir, { recursive: true });

  for (const peerName of peers) {
    const linkPath = path.join(nodeModulesDir, peerName);

    try {
      await fs.rm(linkPath, { recursive: true, force: true });
      await fs.symlink(hostRoot, linkPath, "junction");
      params.logger.info?.(`Linked peerDependency "${peerName}" -> ${hostRoot}`);
    } catch (err) {
      params.logger.warn?.(`Failed to symlink peerDependency "${peerName}": ${String(err)}`);
    }
  }
}

function resolveManagedPackageJsonPath(params: {
  rootDir: string;
  packageJsonPath?: string;
}): string | undefined {
  if (!params.packageJsonPath) {
    return undefined;
  }
  const packageJsonPath = path.resolve(params.rootDir, params.packageJsonPath);
  const relative = path.relative(params.rootDir, packageJsonPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return packageJsonPath;
}

async function readPackagePeerDependencies(
  packageJsonPath: string | undefined,
): Promise<Record<string, string>> {
  if (!packageJsonPath) {
    return {};
  }
  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { peerDependencies?: unknown };
    if (!parsed.peerDependencies || typeof parsed.peerDependencies !== "object") {
      return {};
    }
    const peers: Record<string, string> = {};
    for (const [name, version] of Object.entries(parsed.peerDependencies)) {
      if (typeof version === "string") {
        peers[name] = version;
      }
    }
    return peers;
  } catch {
    return {};
  }
}

/**
 * Re-assert host OpenClaw peer links for managed installed plugins before any
 * gateway runtime import can resolve plugin code. This is intentionally a
 * narrow boot-time repair for installs updated outside the plugin installer
 * path (for example Homebrew replacing the host package under a managed npm
 * plugin root).
 */
export async function relinkOpenClawPeerDependenciesForInstalledPlugins(params: {
  index: InstalledPluginIndex;
  logger: PluginPeerLinkLogger;
}): Promise<{ checked: number; attempted: number }> {
  let checked = 0;
  let attempted = 0;
  for (const record of params.index.plugins) {
    if (!record.enabled) {
      continue;
    }
    if (!record.installRecord && !params.index.installRecords[record.pluginId]) {
      continue;
    }
    const packageJsonPath = resolveManagedPackageJsonPath({
      rootDir: record.rootDir,
      packageJsonPath: record.packageJson?.path,
    });
    const peerDependencies = await readPackagePeerDependencies(packageJsonPath);
    if (!Object.hasOwn(peerDependencies, "openclaw")) {
      continue;
    }
    checked += 1;
    await linkOpenClawPeerDependencies({
      installedDir: record.rootDir,
      peerDependencies,
      logger: params.logger,
    });
    attempted += 1;
  }
  return { checked, attempted };
}
