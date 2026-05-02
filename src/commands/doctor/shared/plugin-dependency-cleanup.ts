import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { resolveOpenClawPackageRootSync } from "../../../infra/openclaw-root.js";
import { resolveConfigDir, resolveUserPath } from "../../../utils.js";

const LEGACY_DIRECT_CHILD_NAMES = new Set(["plugin-runtime-deps", "bundled-plugin-runtime-deps"]);
const VERSIONED_RUNTIME_DEPS_ROOT_RE = /^openclaw-(\d{4}\.\d{1,2}\.\d{1,2})-[a-fA-F0-9]{8,}$/u;

function uniqueSorted(values: Iterable<string | null | undefined>): string[] {
  return [
    ...new Set(
      [...values]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .map((value) => path.resolve(value)),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function splitPathList(value: string | undefined): string[] {
  return value
    ? value
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isLegacyDependencyDebrisName(name: string): boolean {
  return (
    name === "node_modules" ||
    name === ".openclaw-runtime-deps.json" ||
    name === ".openclaw-runtime-deps-stamp.json" ||
    name === ".openclaw-pnpm-store" ||
    name === ".openclaw-install-backups" ||
    name.startsWith(".openclaw-runtime-deps-") ||
    name.startsWith(".openclaw-install-stage-")
  );
}

async function collectDirectChildren(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.map((entry) => path.join(root, entry.name));
}

async function readPackageVersion(packageRoot: string | null): Promise<string | null> {
  if (!packageRoot) {
    return null;
  }
  try {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf-8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version.length > 0
      ? packageJson.version
      : null;
  } catch {
    return null;
  }
}

async function collectLegacyRuntimeDepsRootTargets(
  runtimeRoot: string,
  currentPackageVersion: string | null,
): Promise<string[]> {
  const entries = await fs.readdir(runtimeRoot, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return [];
  }
  const currentPrefix = currentPackageVersion ? `openclaw-${currentPackageVersion}-` : null;
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        VERSIONED_RUNTIME_DEPS_ROOT_RE.test(entry.name) &&
        (currentPrefix === null || !entry.name.startsWith(currentPrefix)),
    )
    .map((entry) => path.join(runtimeRoot, entry.name));
}

async function collectExplicitStageRootTargets(
  explicitStageRoots: readonly string[],
  currentPackageVersion: string | null,
): Promise<string[]> {
  const targets: string[] = [];
  for (const explicitStageRoot of explicitStageRoots) {
    if (path.basename(explicitStageRoot) === "plugin-runtime-deps") {
      targets.push(
        ...(await collectLegacyRuntimeDepsRootTargets(explicitStageRoot, currentPackageVersion)),
      );
      continue;
    }
    targets.push(explicitStageRoot);
  }
  return targets;
}

async function collectLegacyExtensionDebris(extensionsRoot: string): Promise<string[]> {
  const pluginDirs = await fs.readdir(extensionsRoot, { withFileTypes: true }).catch(() => []);
  const targets: string[] = [];
  for (const entry of pluginDirs) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const pluginRoot = path.join(extensionsRoot, entry.name);
    for (const childPath of await collectDirectChildren(pluginRoot)) {
      if (isLegacyDependencyDebrisName(path.basename(childPath))) {
        targets.push(childPath);
      }
    }
  }
  return targets;
}

async function collectLegacyPluginDependencyTargets(
  env: NodeJS.ProcessEnv = process.env,
  options: { packageRoot?: string | null } = {},
): Promise<string[]> {
  const packageRoot =
    options.packageRoot ??
    resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      cwd: process.cwd(),
    });
  const roots = uniqueSorted([resolveStateDir(env), resolveConfigDir(env), packageRoot]);
  const currentPackageVersion = await readPackageVersion(packageRoot);
  const explicitStageRoots = splitPathList(env.OPENCLAW_PLUGIN_STAGE_DIR).map((entry) =>
    resolveUserPath(entry, env),
  );
  const stateDirectoryRoots = splitPathList(env.STATE_DIRECTORY).map((entry) =>
    path.join(resolveUserPath(entry, env), "plugin-runtime-deps"),
  );
  const explicitStageTargets = await collectExplicitStageRootTargets(
    explicitStageRoots,
    currentPackageVersion,
  );
  const targets = [
    ...explicitStageTargets,
    ...roots.flatMap((root) => [
      ...[...LEGACY_DIRECT_CHILD_NAMES]
        .filter((name) => name !== "plugin-runtime-deps")
        .map((name) => path.join(root, name)),
      path.join(root, ".local", "bundled-plugin-runtime-deps"),
    ]),
  ];
  const runtimeRoots = uniqueSorted([
    ...stateDirectoryRoots,
    ...roots.map((root) => path.join(root, "plugin-runtime-deps")),
  ]);
  for (const runtimeRoot of runtimeRoots) {
    targets.push(
      ...(await collectLegacyRuntimeDepsRootTargets(runtimeRoot, currentPackageVersion)),
    );
  }
  for (const root of roots) {
    targets.push(...(await collectLegacyExtensionDebris(path.join(root, "extensions"))));
    targets.push(...(await collectLegacyExtensionDebris(path.join(root, "dist", "extensions"))));
  }
  return uniqueSorted(targets);
}

export async function cleanupLegacyPluginDependencyState(params: {
  env?: NodeJS.ProcessEnv;
  packageRoot?: string | null;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const target of await collectLegacyPluginDependencyTargets(env, {
    packageRoot: params.packageRoot,
  })) {
    if (!(await pathExists(target))) {
      continue;
    }
    try {
      await fs.rm(target, { recursive: true, force: true });
      changes.push(`Removed legacy plugin dependency state: ${target}`);
    } catch (error) {
      warnings.push(`Failed to remove legacy plugin dependency state ${target}: ${String(error)}`);
    }
  }
  return { changes, warnings };
}

export const __testing = {
  collectLegacyPluginDependencyTargets,
};
