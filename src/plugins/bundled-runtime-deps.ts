import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Module } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLowDiskSpaceWarning } from "../infra/disk-space.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { beginBundledRuntimeDepsInstall } from "./bundled-runtime-deps-activity.js";
import {
  BUNDLED_RUNTIME_DEPS_LOCK_DIR,
  formatRuntimeDepsLockTimeoutMessage,
  removeRuntimeDepsLockIfStale,
  shouldRemoveRuntimeDepsLock,
  withBundledRuntimeDepsFilesystemLock,
  withBundledRuntimeDepsFilesystemLockAsync,
} from "./bundled-runtime-deps-lock.js";
import {
  createBundledRuntimeDepsInstallArgs,
  createBundledRuntimeDepsInstallEnv,
  resolveBundledRuntimeDepsNpmRunner,
  resolveBundledRuntimeDepsPackageManagerRunner,
  resolveBundledRuntimeDepsPnpmRunner,
  type BundledRuntimeDepsNpmRunner,
  type BundledRuntimeDepsPackageManager,
  type BundledRuntimeDepsPackageManagerRunner,
} from "./bundled-runtime-deps-package-manager.js";
import { normalizePluginsConfig } from "./config-state.js";
import { passesManifestOwnerBasePolicy } from "./manifest-owner-policy.js";
import { satisfies, validSemver } from "./semver.runtime.js";

export {
  createBundledRuntimeDepsInstallArgs,
  createBundledRuntimeDepsInstallEnv,
  resolveBundledRuntimeDepsNpmRunner,
  withBundledRuntimeDepsFilesystemLock,
};
export type { BundledRuntimeDepsNpmRunner };

export const __testing = {
  formatRuntimeDepsLockTimeoutMessage,
  resolveBundledRuntimeDepsPnpmRunner,
  shouldRemoveRuntimeDepsLock,
};

export type RuntimeDepEntry = {
  name: string;
  version: string;
  pluginIds: string[];
};

export type RuntimeDepConflict = {
  name: string;
  versions: string[];
  pluginIdsByVersion: Map<string, string[]>;
};

export type BundledRuntimeDepsInstallParams = {
  installRoot: string;
  installExecutionRoot?: string;
  missingSpecs: string[];
  installSpecs?: string[];
  warn?: (message: string) => void;
};

export type BundledRuntimeDepsEnsureResult = {
  installedSpecs: string[];
};

export type BundledRuntimeDepsInstallRoot = {
  installRoot: string;
  external: boolean;
};

export type BundledRuntimeDepsInstallRootPlan = BundledRuntimeDepsInstallRoot & {
  searchRoots: string[];
};

export type BundledRuntimeDepsPlan = {
  deps: RuntimeDepEntry[];
  missing: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
  installSpecs: string[];
  installRootPlan: BundledRuntimeDepsInstallRootPlan;
};

type JsonObject = Record<string, unknown>;
const LEGACY_RETAINED_RUNTIME_DEPS_MANIFEST = ".openclaw-runtime-deps.json";
// Packaged bundled plugins (Docker image, npm global install) keep their
// `package.json` next to their entry point; running `npm install <specs>` with
// `cwd: pluginRoot` would make npm resolve the plugin's own `workspace:*`
// dependencies and fail with `EUNSUPPORTEDPROTOCOL`. To avoid that, stage the
// install inside this sub-directory and move the produced `node_modules/` back
// to the plugin root.
const PLUGIN_ROOT_INSTALL_STAGE_DIR = ".openclaw-install-stage";
const DEFAULT_UNKNOWN_RUNTIME_DEPS_ROOTS_TO_KEEP = 20;
const DEFAULT_UNKNOWN_RUNTIME_DEPS_MIN_AGE_MS = 10 * 60_000;
const BUNDLED_RUNTIME_DEPS_INSTALL_PROGRESS_INTERVAL_MS = 5_000;
const MIRRORED_PACKAGE_RUNTIME_DEP_PLUGIN_ID = "openclaw-core";
const MAX_RUNTIME_DEPS_FILE_CACHE_ENTRIES = 2048;

const registeredBundledRuntimeDepNodePaths = new Set<string>();
const runtimeDepsTextFileCache = new Map<string, { signature: string; value: string }>();
const runtimeDepsJsonObjectCache = new Map<
  string,
  { signature: string; value: JsonObject | null }
>();

function createBundledRuntimeDepsEnsureResult(
  installedSpecs: string[],
): BundledRuntimeDepsEnsureResult {
  return { installedSpecs };
}

const BUNDLED_RUNTIME_DEP_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;

function normalizeInstallableRuntimeDepName(rawName: string): string | null {
  const depName = rawName.trim();
  if (depName === "") {
    return null;
  }
  const segments = depName.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  if (segments.length === 1) {
    return BUNDLED_RUNTIME_DEP_SEGMENT_RE.test(segments[0] ?? "") ? depName : null;
  }
  if (segments.length !== 2 || !segments[0]?.startsWith("@")) {
    return null;
  }
  const scope = segments[0].slice(1);
  const packageName = segments[1];
  return BUNDLED_RUNTIME_DEP_SEGMENT_RE.test(scope) &&
    BUNDLED_RUNTIME_DEP_SEGMENT_RE.test(packageName ?? "")
    ? depName
    : null;
}

function normalizeInstallableRuntimeDepVersion(rawVersion: unknown): string | null {
  if (typeof rawVersion !== "string") {
    return null;
  }
  const version = rawVersion.trim();
  if (version === "" || version.toLowerCase().startsWith("workspace:")) {
    return null;
  }
  if (validSemver(version)) {
    return version;
  }
  const rangePrefix = version[0];
  if ((rangePrefix === "^" || rangePrefix === "~") && validSemver(version.slice(1))) {
    return version;
  }
  return null;
}

function parseInstallableRuntimeDep(
  name: string,
  rawVersion: unknown,
): { name: string; version: string } | null {
  if (typeof rawVersion !== "string") {
    return null;
  }
  const version = rawVersion.trim();
  if (version === "" || version.toLowerCase().startsWith("workspace:")) {
    return null;
  }
  const normalizedName = normalizeInstallableRuntimeDepName(name);
  if (!normalizedName) {
    throw new Error(`Invalid bundled runtime dependency name: ${name}`);
  }
  const normalizedVersion = normalizeInstallableRuntimeDepVersion(version);
  if (!normalizedVersion) {
    throw new Error(
      `Unsupported bundled runtime dependency spec for ${normalizedName}: ${version}`,
    );
  }
  return { name: normalizedName, version: normalizedVersion };
}

function parseInstallableRuntimeDepSpec(spec: string): { name: string; version: string } {
  const atIndex = spec.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === spec.length - 1) {
    throw new Error(`Invalid bundled runtime dependency install spec: ${spec}`);
  }
  const parsed = parseInstallableRuntimeDep(spec.slice(0, atIndex), spec.slice(atIndex + 1));
  if (!parsed) {
    throw new Error(`Invalid bundled runtime dependency install spec: ${spec}`);
  }
  return parsed;
}

function dependencySentinelPath(depName: string): string {
  const normalizedDepName = normalizeInstallableRuntimeDepName(depName);
  if (!normalizedDepName) {
    throw new Error(`Invalid bundled runtime dependency name: ${depName}`);
  }
  return path.join("node_modules", ...normalizedDepName.split("/"), "package.json");
}

function resolveDependencySentinelAbsolutePath(rootDir: string, depName: string): string {
  const nodeModulesDir = path.resolve(rootDir, "node_modules");
  const sentinelPath = path.resolve(rootDir, dependencySentinelPath(depName));
  if (sentinelPath !== nodeModulesDir && !sentinelPath.startsWith(`${nodeModulesDir}${path.sep}`)) {
    throw new Error(`Blocked runtime dependency path escape for ${depName}`);
  }
  return sentinelPath;
}

function readJsonObject(filePath: string): JsonObject | null {
  const signature = getRuntimeDepsFileSignature(filePath);
  const cached = signature ? runtimeDepsJsonObjectCache.get(filePath) : undefined;
  if (cached?.signature === signature) {
    return cached.value;
  }
  const source = readRuntimeDepsTextFile(filePath, signature);
  if (source === null) {
    cacheRuntimeDepsJsonObject(filePath, signature, null);
    return null;
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      cacheRuntimeDepsJsonObject(filePath, signature, null);
      return null;
    }
    const value = parsed as JsonObject;
    cacheRuntimeDepsJsonObject(filePath, signature, value);
    return value;
  } catch {
    cacheRuntimeDepsJsonObject(filePath, signature, null);
    return null;
  }
}

function readRuntimeDepsTextFile(filePath: string, signature?: string | null): string | null {
  const fileSignature = signature ?? getRuntimeDepsFileSignature(filePath);
  const cached = fileSignature ? runtimeDepsTextFileCache.get(filePath) : undefined;
  if (cached?.signature === fileSignature) {
    return cached.value;
  }
  try {
    const value = fs.readFileSync(filePath, "utf8");
    if (fileSignature) {
      rememberRuntimeDepsCacheEntry(runtimeDepsTextFileCache, filePath, {
        signature: fileSignature,
        value,
      });
    }
    return value;
  } catch {
    return null;
  }
}

function getRuntimeDepsFileSignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile()) {
      return null;
    }
    return [
      stat.dev.toString(),
      stat.ino.toString(),
      stat.size.toString(),
      stat.mtimeNs.toString(),
    ].join(":");
  } catch {
    return null;
  }
}

function cacheRuntimeDepsJsonObject(
  filePath: string,
  signature: string | null,
  value: JsonObject | null,
): void {
  if (!signature) {
    return;
  }
  rememberRuntimeDepsCacheEntry(runtimeDepsJsonObjectCache, filePath, { signature, value });
}

function rememberRuntimeDepsCacheEntry<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= MAX_RUNTIME_DEPS_FILE_CACHE_ENTRIES && !cache.has(key)) {
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(key, value);
}

function withBundledRuntimeDepsInstallRootLock<T>(installRoot: string, run: () => T): T {
  return withBundledRuntimeDepsFilesystemLock(installRoot, BUNDLED_RUNTIME_DEPS_LOCK_DIR, run);
}

async function withBundledRuntimeDepsInstallRootLockAsync<T>(
  installRoot: string,
  run: () => Promise<T>,
): Promise<T> {
  return await withBundledRuntimeDepsFilesystemLockAsync(
    installRoot,
    BUNDLED_RUNTIME_DEPS_LOCK_DIR,
    run,
  );
}

function collectRuntimeDeps(packageJson: JsonObject): Record<string, unknown> {
  return {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.optionalDependencies as Record<string, unknown> | undefined),
  };
}

function collectDeclaredMirroredRootRuntimeDepNames(packageJson: JsonObject): string[] {
  const openclaw = packageJson.openclaw;
  const bundle =
    openclaw && typeof openclaw === "object" && !Array.isArray(openclaw)
      ? (openclaw as JsonObject).bundle
      : undefined;
  const rawNames =
    bundle && typeof bundle === "object" && !Array.isArray(bundle)
      ? (bundle as JsonObject).mirroredRootRuntimeDependencies
      : undefined;
  if (rawNames === undefined) {
    return [];
  }
  if (!Array.isArray(rawNames)) {
    throw new Error("openclaw.bundle.mirroredRootRuntimeDependencies must be an array");
  }
  const names = new Set<string>();
  for (const rawName of rawNames) {
    if (typeof rawName !== "string") {
      throw new Error("openclaw.bundle.mirroredRootRuntimeDependencies must contain strings");
    }
    const normalizedName = normalizeInstallableRuntimeDepName(rawName);
    if (!normalizedName) {
      throw new Error(`Invalid mirrored bundled runtime dependency name: ${rawName}`);
    }
    names.add(normalizedName);
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

function collectMirroredPackageRuntimeDeps(packageRoot: string | null): {
  name: string;
  version: string;
  pluginIds: string[];
}[] {
  if (!packageRoot) {
    return [];
  }
  const packageJson = readJsonObject(path.join(packageRoot, "package.json"));
  if (!packageJson) {
    return [];
  }
  const runtimeDeps = collectRuntimeDeps(packageJson);
  const deps: RuntimeDepEntry[] = [];
  for (const name of collectDeclaredMirroredRootRuntimeDepNames(packageJson)) {
    const dep = parseInstallableRuntimeDep(name, runtimeDeps[name]);
    if (!dep) {
      throw new Error(
        `Declared mirrored bundled runtime dependency ${name} is missing from package dependencies`,
      );
    }
    deps.push({
      ...dep,
      pluginIds: [MIRRORED_PACKAGE_RUNTIME_DEP_PLUGIN_ID],
    });
  }
  return deps.toSorted((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    return nameOrder === 0 ? left.version.localeCompare(right.version) : nameOrder;
  });
}

function mergeRuntimeDepEntries(deps: readonly RuntimeDepEntry[]): RuntimeDepEntry[] {
  const bySpec = new Map<string, RuntimeDepEntry>();
  for (const dep of deps) {
    const spec = `${dep.name}@${dep.version}`;
    const existing = bySpec.get(spec);
    if (!existing) {
      bySpec.set(spec, { ...dep, pluginIds: [...dep.pluginIds] });
      continue;
    }
    existing.pluginIds = [...new Set([...existing.pluginIds, ...dep.pluginIds])].toSorted(
      (left, right) => left.localeCompare(right),
    );
  }
  return [...bySpec.values()].toSorted((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    return nameOrder === 0 ? left.version.localeCompare(right.version) : nameOrder;
  });
}

function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    (fs.existsSync(path.join(packageRoot, ".git")) ||
      fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml"))) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
  );
}

function resolveBundledPluginPackageRoot(pluginRoot: string): string | null {
  const extensionsDir = path.dirname(path.resolve(pluginRoot));
  const buildDir = path.dirname(extensionsDir);
  if (
    path.basename(extensionsDir) !== "extensions" ||
    (path.basename(buildDir) !== "dist" && path.basename(buildDir) !== "dist-runtime")
  ) {
    return null;
  }
  return path.dirname(buildDir);
}

export function resolveBundledRuntimeDependencyPackageRoot(pluginRoot: string): string | null {
  return resolveBundledPluginPackageRoot(pluginRoot);
}

export function registerBundledRuntimeDependencyNodePath(rootDir: string): void {
  const nodeModulesDir = path.join(rootDir, "node_modules");
  if (registeredBundledRuntimeDepNodePaths.has(nodeModulesDir) || !fs.existsSync(nodeModulesDir)) {
    return;
  }
  const currentPaths = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  process.env.NODE_PATH = [
    nodeModulesDir,
    ...currentPaths.filter((entry) => entry !== nodeModulesDir),
  ].join(path.delimiter);
  (Module as unknown as { _initPaths?: () => void })._initPaths?.();
  registeredBundledRuntimeDepNodePaths.add(nodeModulesDir);
}

export function clearBundledRuntimeDependencyNodePaths(): void {
  if (registeredBundledRuntimeDepNodePaths.size === 0) {
    return;
  }
  const retainedPaths = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && !registeredBundledRuntimeDepNodePaths.has(entry));
  if (retainedPaths.length > 0) {
    process.env.NODE_PATH = retainedPaths.join(path.delimiter);
  } else {
    delete process.env.NODE_PATH;
  }
  registeredBundledRuntimeDepNodePaths.clear();
  (Module as unknown as { _initPaths?: () => void })._initPaths?.();
}

function isPackagedBundledPluginRoot(pluginRoot: string): boolean {
  const packageRoot = resolveBundledPluginPackageRoot(pluginRoot);
  return Boolean(packageRoot && !isSourceCheckoutRoot(packageRoot));
}

function createPathHash(value: string): string {
  return createHash("sha256").update(path.resolve(value)).digest("hex").slice(0, 12);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function readPackageVersion(packageRoot: string): string {
  const parsed = readJsonObject(path.join(packageRoot, "package.json"));
  const version = parsed && typeof parsed.version === "string" ? parsed.version.trim() : "";
  return version || "unknown";
}

function normalizeRuntimeDepSpecs(specs: readonly string[]): string[] {
  specs.forEach((spec) => {
    parseInstallableRuntimeDepSpec(spec);
  });
  return [...new Set(specs)].toSorted((left, right) => left.localeCompare(right));
}

function readGeneratedInstallManifestSpecs(installRoot: string): string[] | null {
  const parsed = readJsonObject(path.join(installRoot, "package.json"));
  if (parsed?.name !== "openclaw-runtime-deps-install") {
    return null;
  }
  const dependencies = parsed.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    return [];
  }
  const specs: string[] = [];
  for (const [name, version] of Object.entries(dependencies as Record<string, unknown>)) {
    const dep = parseInstallableRuntimeDep(name, version);
    if (dep) {
      specs.push(`${dep.name}@${dep.version}`);
    }
  }
  return normalizeRuntimeDepSpecs(specs);
}

function readPackageRuntimeDepSpecs(packageRoot: string): string[] | null {
  const parsed = readJsonObject(path.join(packageRoot, "package.json"));
  if (!parsed || parsed.name === "openclaw-runtime-deps-install") {
    return null;
  }
  const specs = Object.entries(collectRuntimeDeps(parsed))
    .map(([name, rawVersion]) => parseInstallableRuntimeDep(name, rawVersion))
    .filter((dep): dep is { name: string; version: string } => Boolean(dep))
    .map((dep) => `${dep.name}@${dep.version}`);
  return normalizeRuntimeDepSpecs(specs);
}

function sameRuntimeDepSpecs(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = normalizeRuntimeDepSpecs(left);
  const normalizedRight = normalizeRuntimeDepSpecs(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((entry, index) => entry === normalizedRight[index])
  );
}

function readInstalledRuntimeDepVersion(rootDir: string, depName: string): string | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(resolveDependencySentinelAbsolutePath(rootDir, depName), "utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const version = (parsed as JsonObject).version;
    return typeof version === "string" && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

function isRuntimeDepSatisfied(rootDir: string, dep: { name: string; version: string }): boolean {
  const installedVersion = readInstalledRuntimeDepVersion(rootDir, dep.name);
  return Boolean(installedVersion && satisfies(installedVersion, dep.version));
}

function isRuntimeDepSatisfiedInAnyRoot(
  dep: { name: string; version: string },
  roots: readonly string[],
): boolean {
  return roots.some((root) => isRuntimeDepSatisfied(root, dep));
}

function hasSatisfiedInstallSpecPackages(rootDir: string, specs: readonly string[]): boolean {
  return specs
    .map(parseInstallableRuntimeDepSpec)
    .every((dep) => isRuntimeDepSatisfied(rootDir, dep));
}

function isRuntimeDepsPlanMaterialized(
  installRoot: string,
  installSpecs: readonly string[],
): boolean {
  const generatedManifestSpecs = readGeneratedInstallManifestSpecs(installRoot);
  const packageManifestSpecs =
    generatedManifestSpecs !== null ? null : readPackageRuntimeDepSpecs(installRoot);
  return (
    ((generatedManifestSpecs !== null &&
      sameRuntimeDepSpecs(generatedManifestSpecs, installSpecs)) ||
      (packageManifestSpecs !== null && sameRuntimeDepSpecs(packageManifestSpecs, installSpecs))) &&
    hasSatisfiedInstallSpecPackages(installRoot, installSpecs)
  );
}

function removeLegacyRuntimeDepsManifest(installRoot: string): void {
  fs.rmSync(path.join(installRoot, LEGACY_RETAINED_RUNTIME_DEPS_MANIFEST), {
    force: true,
  });
}

export function isWritableDirectory(dir: string): boolean {
  let probeDir: string | null = null;
  try {
    probeDir = fs.mkdtempSync(path.join(dir, ".openclaw-write-probe-"));
    fs.writeFileSync(path.join(probeDir, "probe"), "", "utf8");
    return true;
  } catch {
    return false;
  } finally {
    if (probeDir) {
      try {
        fs.rmSync(probeDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup. A failed cleanup should not turn a writable
        // probe into a hard runtime-dependency failure.
      }
    }
  }
}

function resolveSystemdStateDirectory(env: NodeJS.ProcessEnv): string | null {
  const raw = env.STATE_DIRECTORY?.trim();
  if (!raw) {
    return null;
  }
  const first = raw.split(path.delimiter).find((entry) => entry.trim().length > 0);
  return first ? path.resolve(first) : null;
}

function resolveBundledRuntimeDepsExternalBaseDirs(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.OPENCLAW_PLUGIN_STAGE_DIR?.trim();
  if (explicit) {
    const roots = explicit
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => path.resolve(resolveHomeRelativePath(entry, { env, homedir: os.homedir })));
    if (roots.length > 0) {
      const uniqueRoots: string[] = [];
      for (const root of roots) {
        const existingIndex = uniqueRoots.findIndex(
          (entry) => path.resolve(entry) === path.resolve(root),
        );
        if (existingIndex >= 0) {
          uniqueRoots.splice(existingIndex, 1);
        }
        uniqueRoots.push(root);
      }
      return uniqueRoots;
    }
  }
  const systemdStateDir = resolveSystemdStateDirectory(env);
  if (systemdStateDir) {
    return [path.join(systemdStateDir, "plugin-runtime-deps")];
  }
  return [path.join(resolveStateDir(env, os.homedir), "plugin-runtime-deps")];
}

export function pruneUnknownBundledRuntimeDepsRoots(
  params: {
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
    maxRootsToKeep?: number;
    minAgeMs?: number;
    warn?: (message: string) => void;
  } = {},
): { scanned: number; removed: number; skippedLocked: number } {
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const maxRootsToKeep = Math.max(
    0,
    params.maxRootsToKeep ?? DEFAULT_UNKNOWN_RUNTIME_DEPS_ROOTS_TO_KEEP,
  );
  const minAgeMs = Math.max(0, params.minAgeMs ?? DEFAULT_UNKNOWN_RUNTIME_DEPS_MIN_AGE_MS);
  let scanned = 0;
  let removed = 0;
  let skippedLocked = 0;

  for (const baseDir of resolveBundledRuntimeDepsExternalBaseDirs(env)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const unknownRoots = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("openclaw-unknown-"))
      .map((entry) => {
        const root = path.join(baseDir, entry.name);
        try {
          return { root, mtimeMs: fs.statSync(root).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { root: string; mtimeMs: number } => entry !== null)
      .toSorted((left, right) => right.mtimeMs - left.mtimeMs);
    scanned += unknownRoots.length;

    for (const [index, entry] of unknownRoots.entries()) {
      const ageMs = nowMs - entry.mtimeMs;
      if (index < maxRootsToKeep && ageMs < minAgeMs) {
        continue;
      }
      const lockDir = path.join(entry.root, BUNDLED_RUNTIME_DEPS_LOCK_DIR);
      if (fs.existsSync(lockDir) && !removeRuntimeDepsLockIfStale(lockDir, nowMs)) {
        skippedLocked += 1;
        continue;
      }
      try {
        fs.rmSync(entry.root, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        params.warn?.(
          `failed to remove stale bundled runtime deps root ${entry.root}: ${String(error)}`,
        );
      }
    }
  }

  return { scanned, removed, skippedLocked };
}

function resolveExternalBundledRuntimeDepsInstallRoot(params: {
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
}): string {
  return resolveExternalBundledRuntimeDepsInstallRoots(params).at(-1)!;
}

function resolveExternalBundledRuntimeDepsInstallRoots(params: {
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const packageRoot = resolveBundledPluginPackageRoot(params.pluginRoot) ?? params.pluginRoot;
  const existingExternalRoots = resolveExistingExternalBundledRuntimeDepsRoots({
    packageRoot,
    env: params.env,
  });
  if (existingExternalRoots) {
    return existingExternalRoots;
  }
  const version = sanitizePathSegment(readPackageVersion(packageRoot));
  const packageKey = `openclaw-${version}-${createPathHash(packageRoot)}`;
  return resolveBundledRuntimeDepsExternalBaseDirs(params.env).map((baseDir) =>
    path.join(baseDir, packageKey),
  );
}

function resolveExistingExternalBundledRuntimeDepsRoots(params: {
  packageRoot: string;
  env: NodeJS.ProcessEnv;
}): string[] | null {
  const packageRoot = realpathOrResolve(params.packageRoot);
  const externalBaseDirs = resolveBundledRuntimeDepsExternalBaseDirs(params.env);
  for (const externalBaseDir of externalBaseDirs) {
    const relative = path.relative(realpathOrResolve(externalBaseDir), packageRoot);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    const packageKey = relative.split(path.sep)[0];
    if (!packageKey || !packageKey.startsWith("openclaw-")) {
      continue;
    }
    return externalBaseDirs.map((baseDir) => path.join(baseDir, packageKey));
  }
  return null;
}

function realpathOrResolve(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function createBundledRuntimeDepsInstallRootPlan(params: {
  installRoot: string;
  searchRoots: readonly string[];
  external: boolean;
}): BundledRuntimeDepsInstallRootPlan {
  const searchRoots: string[] = [];
  for (const root of params.searchRoots) {
    const resolved = path.resolve(root);
    if (!searchRoots.some((entry) => path.resolve(entry) === resolved)) {
      searchRoots.push(root);
    }
  }
  if (!searchRoots.some((entry) => path.resolve(entry) === path.resolve(params.installRoot))) {
    searchRoots.push(params.installRoot);
  }
  return {
    installRoot: params.installRoot,
    searchRoots,
    external: params.external,
  };
}

export function createBundledRuntimeDepsInstallSpecs(params: {
  deps: readonly { name: string; version: string }[];
}): string[] {
  return params.deps
    .map((dep) => `${dep.name}@${dep.version}`)
    .toSorted((left, right) => left.localeCompare(right));
}

function createBundledRuntimeDepsPlan(params: {
  deps: readonly RuntimeDepEntry[];
  conflicts: readonly RuntimeDepConflict[];
  installRootPlan: BundledRuntimeDepsInstallRootPlan;
}): BundledRuntimeDepsPlan {
  const deps = mergeRuntimeDepEntries(params.deps);
  return {
    deps,
    missing: deps.filter(
      (dep) => !isRuntimeDepSatisfiedInAnyRoot(dep, params.installRootPlan.searchRoots),
    ),
    conflicts: [...params.conflicts],
    installSpecs: createBundledRuntimeDepsInstallSpecs({ deps }),
    installRootPlan: params.installRootPlan,
  };
}

function assertBundledRuntimeDepsInstalled(rootDir: string, specs: readonly string[]): void {
  const missingSpecs = specs.filter((spec) => {
    const dep = parseInstallableRuntimeDepSpec(spec);
    return !isRuntimeDepSatisfied(rootDir, dep);
  });
  if (missingSpecs.length === 0) {
    return;
  }
  throw new Error(
    `package manager install did not place bundled runtime deps in ${rootDir}: ${missingSpecs.join(", ")}`,
  );
}

function replaceNodeModulesDir(targetDir: string, sourceDir: string): void {
  const parentDir = path.dirname(targetDir);
  const tempDir = fs.mkdtempSync(path.join(parentDir, ".openclaw-runtime-deps-copy-"));
  const stagedDir = path.join(tempDir, "node_modules");
  try {
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Stale temp dirs are swept at the next runtime-deps pass. Do not fail
      // a node_modules replacement on a transient cleanup race.
    }
  }
}

type BundledPluginRuntimeDepsManifest = {
  channels: string[];
  enabledByDefault: boolean;
};

type BundledPluginRuntimeDepsManifestCache = Map<string, BundledPluginRuntimeDepsManifest>;

function readBundledPluginRuntimeDepsManifest(
  pluginDir: string,
  cache?: BundledPluginRuntimeDepsManifestCache,
): BundledPluginRuntimeDepsManifest {
  const cached = cache?.get(pluginDir);
  if (cached) {
    return cached;
  }
  const manifest = readJsonObject(path.join(pluginDir, "openclaw.plugin.json"));
  const channels = manifest?.channels;
  const runtimeDepsManifest = {
    channels: Array.isArray(channels)
      ? channels.filter((entry): entry is string => typeof entry === "string" && entry !== "")
      : [],
    enabledByDefault: manifest?.enabledByDefault === true,
  };
  cache?.set(pluginDir, runtimeDepsManifest);
  return runtimeDepsManifest;
}

function isBundledPluginConfiguredForRuntimeDeps(params: {
  config: OpenClawConfig;
  pluginId: string;
  pluginDir: string;
  includeConfiguredChannels?: boolean;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
}): boolean {
  const plugins = normalizePluginsConfig(params.config.plugins);
  if (
    !passesManifestOwnerBasePolicy({
      plugin: { id: params.pluginId },
      normalizedConfig: plugins,
      allowRestrictiveAllowlistBypass: true,
    })
  ) {
    return false;
  }
  const entry = plugins.entries[params.pluginId];
  const manifest = readBundledPluginRuntimeDepsManifest(params.pluginDir, params.manifestCache);
  if (plugins.slots.memory === params.pluginId || plugins.slots.contextEngine === params.pluginId) {
    return true;
  }
  let hasExplicitChannelDisable = false;
  let hasConfiguredChannel = false;
  for (const channelId of manifest.channels) {
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
    if (!normalizedChannelId) {
      continue;
    }
    const channelConfig = (params.config.channels as Record<string, unknown> | undefined)?.[
      normalizedChannelId
    ];
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === false
    ) {
      hasExplicitChannelDisable = true;
      continue;
    }
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === true
    ) {
      return true;
    }
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      params.includeConfiguredChannels
    ) {
      hasConfiguredChannel = true;
    }
  }
  if (hasExplicitChannelDisable) {
    return false;
  }
  if (plugins.allow.length > 0 && !plugins.allow.includes(params.pluginId)) {
    return false;
  }
  if (entry?.enabled === true) {
    return true;
  }
  if (hasConfiguredChannel) {
    return true;
  }
  return manifest.enabledByDefault;
}

function isBundledPluginExplicitlyDisabledForRuntimeDeps(params: {
  config: OpenClawConfig;
  pluginId: string;
  pluginDir: string;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
}): boolean {
  const plugins = normalizePluginsConfig(params.config.plugins);
  if (plugins.entries[params.pluginId]?.enabled === false) {
    return true;
  }
  const manifest = readBundledPluginRuntimeDepsManifest(params.pluginDir, params.manifestCache);
  return manifest.channels.some((channelId) => {
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
    if (!normalizedChannelId) {
      return false;
    }
    const channelConfig = (params.config.channels as Record<string, unknown> | undefined)?.[
      normalizedChannelId
    ];
    return (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === false
    );
  });
}

function shouldIncludeBundledPluginRuntimeDeps(params: {
  config?: OpenClawConfig;
  pluginIds?: ReadonlySet<string>;
  selectedPluginIds?: ReadonlySet<string>;
  pluginId: string;
  pluginDir: string;
  includeConfiguredChannels?: boolean;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
}): boolean {
  if (params.selectedPluginIds) {
    return (
      params.selectedPluginIds.has(params.pluginId) &&
      !(
        params.config &&
        isBundledPluginExplicitlyDisabledForRuntimeDeps({
          config: params.config,
          pluginId: params.pluginId,
          pluginDir: params.pluginDir,
          manifestCache: params.manifestCache,
        })
      )
    );
  }
  const scopedToPluginIds = Boolean(params.pluginIds);
  if (params.pluginIds) {
    if (!params.pluginIds.has(params.pluginId)) {
      return false;
    }
    if (!params.config) {
      return true;
    }
  }
  if (!params.config) {
    return true;
  }
  if (scopedToPluginIds) {
    const plugins = normalizePluginsConfig(params.config.plugins);
    return passesManifestOwnerBasePolicy({
      plugin: { id: params.pluginId },
      normalizedConfig: plugins,
      allowRestrictiveAllowlistBypass: true,
    });
  }
  return isBundledPluginConfiguredForRuntimeDeps({
    config: params.config,
    pluginId: params.pluginId,
    pluginDir: params.pluginDir,
    includeConfiguredChannels: params.includeConfiguredChannels,
    manifestCache: params.manifestCache,
  });
}

function collectBundledPluginRuntimeDeps(params: {
  extensionsDir: string;
  config?: OpenClawConfig;
  pluginIds?: ReadonlySet<string>;
  selectedPluginIds?: ReadonlySet<string>;
  includeConfiguredChannels?: boolean;
}): {
  deps: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
  pluginIds: string[];
} {
  const versionMap = new Map<string, Map<string, Set<string>>>();
  const manifestCache: BundledPluginRuntimeDepsManifestCache = new Map();
  const includedPluginIds = new Set<string>();

  for (const entry of fs.readdirSync(params.extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginId = entry.name;
    const pluginDir = path.join(params.extensionsDir, pluginId);
    if (
      !shouldIncludeBundledPluginRuntimeDeps({
        config: params.config,
        pluginIds: params.pluginIds,
        selectedPluginIds: params.selectedPluginIds,
        pluginId,
        pluginDir,
        includeConfiguredChannels: params.includeConfiguredChannels,
        manifestCache,
      })
    ) {
      continue;
    }
    includedPluginIds.add(pluginId);
    const packageJson = readJsonObject(path.join(pluginDir, "package.json"));
    if (!packageJson) {
      continue;
    }
    for (const [name, rawVersion] of Object.entries(collectRuntimeDeps(packageJson))) {
      const dep = parseInstallableRuntimeDep(name, rawVersion);
      if (!dep) {
        continue;
      }
      const byVersion = versionMap.get(dep.name) ?? new Map<string, Set<string>>();
      const pluginIds = byVersion.get(dep.version) ?? new Set<string>();
      pluginIds.add(pluginId);
      byVersion.set(dep.version, pluginIds);
      versionMap.set(dep.name, byVersion);
    }
  }

  const deps: RuntimeDepEntry[] = [];
  const conflicts: RuntimeDepConflict[] = [];
  for (const [name, byVersion] of versionMap.entries()) {
    if (byVersion.size === 1) {
      const [version, pluginIds] = [...byVersion.entries()][0] ?? [];
      if (version) {
        deps.push({
          name,
          version,
          pluginIds: [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
        });
      }
      continue;
    }
    const versions = [...byVersion.keys()].toSorted((a, b) => a.localeCompare(b));
    const pluginIdsByVersion = new Map<string, string[]>();
    for (const [version, pluginIds] of byVersion.entries()) {
      pluginIdsByVersion.set(
        version,
        [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
      );
    }
    conflicts.push({
      name,
      versions,
      pluginIdsByVersion,
    });
  }

  return {
    deps: deps.toSorted((a, b) => a.name.localeCompare(b.name)),
    conflicts: conflicts.toSorted((a, b) => a.name.localeCompare(b.name)),
    pluginIds: [...includedPluginIds].toSorted((a, b) => a.localeCompare(b)),
  };
}

function normalizePluginIdSet(
  pluginIds: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (!pluginIds) {
    return undefined;
  }
  const normalized = pluginIds
    .map((entry) => normalizeOptionalLowercaseString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return new Set(normalized);
}

export function scanBundledPluginRuntimeDeps(params: {
  packageRoot: string;
  config?: OpenClawConfig;
  pluginIds?: readonly string[];
  selectedPluginIds?: readonly string[];
  includeConfiguredChannels?: boolean;
  env?: NodeJS.ProcessEnv;
}): {
  deps: RuntimeDepEntry[];
  missing: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
} {
  if (isSourceCheckoutRoot(params.packageRoot)) {
    return { deps: [], missing: [], conflicts: [] };
  }
  const extensionsDir = path.join(params.packageRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return { deps: [], missing: [], conflicts: [] };
  }
  const { deps, conflicts, pluginIds } = collectBundledPluginRuntimeDeps({
    extensionsDir,
    config: params.config,
    pluginIds: normalizePluginIdSet(params.pluginIds),
    selectedPluginIds: normalizePluginIdSet(params.selectedPluginIds),
    includeConfiguredChannels: params.includeConfiguredChannels,
  });
  const packageRuntimeDeps =
    pluginIds.length > 0 ? collectMirroredPackageRuntimeDeps(params.packageRoot) : [];
  const installRootPlan = resolveBundledRuntimeDependencyPackageInstallRootPlan(
    params.packageRoot,
    {
      env: params.env,
    },
  );
  const plan = createBundledRuntimeDepsPlan({
    deps: [...deps, ...packageRuntimeDeps],
    conflicts,
    installRootPlan,
  });
  return { deps: plan.deps, missing: plan.missing, conflicts: plan.conflicts };
}

export function resolveBundledRuntimeDependencyPackageInstallRootPlan(
  packageRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): BundledRuntimeDepsInstallRootPlan {
  const env = options.env ?? process.env;
  const externalRoots = resolveExternalBundledRuntimeDepsInstallRoots({
    pluginRoot: path.join(packageRoot, "dist", "extensions", "__package__"),
    env,
  });
  if (
    options.forceExternal ||
    env.OPENCLAW_PLUGIN_STAGE_DIR?.trim() ||
    env.STATE_DIRECTORY?.trim() ||
    !isSourceCheckoutRoot(packageRoot)
  ) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot:
        externalRoots.at(-1) ??
        resolveExternalBundledRuntimeDepsInstallRoot({
          pluginRoot: path.join(packageRoot, "dist", "extensions", "__package__"),
          env,
        }),
      searchRoots: externalRoots,
      external: true,
    });
  }
  if (isWritableDirectory(packageRoot)) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot: packageRoot,
      searchRoots: [packageRoot],
      external: false,
    });
  }
  return createBundledRuntimeDepsInstallRootPlan({
    installRoot:
      externalRoots.at(-1) ??
      resolveExternalBundledRuntimeDepsInstallRoot({
        pluginRoot: path.join(packageRoot, "dist", "extensions", "__package__"),
        env,
      }),
    searchRoots: externalRoots,
    external: true,
  });
}

export function resolveBundledRuntimeDependencyPackageInstallRoot(
  packageRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): string {
  return resolveBundledRuntimeDependencyPackageInstallRootPlan(packageRoot, options).installRoot;
}

export function resolveBundledRuntimeDependencyInstallRootPlan(
  pluginRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): BundledRuntimeDepsInstallRootPlan {
  const env = options.env ?? process.env;
  const externalRoots = resolveExternalBundledRuntimeDepsInstallRoots({ pluginRoot, env });
  if (
    options.forceExternal ||
    env.OPENCLAW_PLUGIN_STAGE_DIR?.trim() ||
    env.STATE_DIRECTORY?.trim() ||
    isPackagedBundledPluginRoot(pluginRoot)
  ) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot:
        externalRoots.at(-1) ??
        resolveExternalBundledRuntimeDepsInstallRoot({
          pluginRoot,
          env,
        }),
      searchRoots: externalRoots,
      external: true,
    });
  }
  if (isWritableDirectory(pluginRoot)) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot: pluginRoot,
      searchRoots: [pluginRoot],
      external: false,
    });
  }
  return createBundledRuntimeDepsInstallRootPlan({
    installRoot:
      externalRoots.at(-1) ??
      resolveExternalBundledRuntimeDepsInstallRoot({
        pluginRoot,
        env,
      }),
    searchRoots: externalRoots,
    external: true,
  });
}

export function resolveBundledRuntimeDependencyInstallRoot(
  pluginRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): string {
  return resolveBundledRuntimeDependencyInstallRootPlan(pluginRoot, options).installRoot;
}

export function resolveBundledRuntimeDependencyInstallRootInfo(
  pluginRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): BundledRuntimeDepsInstallRoot {
  const { installRoot, external } = resolveBundledRuntimeDependencyInstallRootPlan(
    pluginRoot,
    options,
  );
  return {
    installRoot,
    external,
  };
}

export function createBundledRuntimeDependencyAliasMap(params: {
  pluginRoot: string;
  installRoot: string;
}): Record<string, string> {
  if (path.resolve(params.installRoot) === path.resolve(params.pluginRoot)) {
    return {};
  }
  const packageJson = readJsonObject(path.join(params.pluginRoot, "package.json"));
  if (!packageJson) {
    return {};
  }
  const aliases: Record<string, string> = {};
  for (const name of Object.keys(collectRuntimeDeps(packageJson)).toSorted((a, b) =>
    a.localeCompare(b),
  )) {
    const normalizedName = normalizeInstallableRuntimeDepName(name);
    if (!normalizedName) {
      continue;
    }
    const target = path.join(params.installRoot, "node_modules", ...normalizedName.split("/"));
    if (fs.existsSync(path.join(target, "package.json"))) {
      aliases[normalizedName] = target;
    }
  }
  return aliases;
}

function shouldCleanBundledRuntimeDepsInstallExecutionRoot(params: {
  installRoot: string;
  installExecutionRoot: string;
}): boolean {
  const installRoot = path.resolve(params.installRoot);
  const installExecutionRoot = path.resolve(params.installExecutionRoot);
  return installExecutionRoot.startsWith(`${installRoot}${path.sep}`);
}

function createNpmInstallExecutionManifest(installSpecs: readonly string[]): JsonObject {
  const dependencies: Record<string, string> = {};
  for (const spec of installSpecs) {
    const dep = parseInstallableRuntimeDepSpec(spec);
    dependencies[dep.name] = dep.version;
  }
  const sortedDependencies = Object.fromEntries(
    Object.entries(dependencies).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  return {
    name: "openclaw-runtime-deps-install",
    private: true,
    ...(Object.keys(sortedDependencies).length > 0 ? { dependencies: sortedDependencies } : {}),
  };
}

function ensureNpmInstallExecutionManifest(
  installExecutionRoot: string,
  installSpecs: readonly string[] = [],
): void {
  const manifestPath = path.join(installExecutionRoot, "package.json");
  const manifest = createNpmInstallExecutionManifest(installSpecs);
  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`;
  if (fs.existsSync(manifestPath) && fs.readFileSync(manifestPath, "utf8") === nextContents) {
    return;
  }
  fs.writeFileSync(manifestPath, nextContents, "utf8");
}

function formatBundledRuntimeDepsInstallError(result: {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  stderr?: string | Buffer | null;
  stdout?: string | Buffer | null;
}): string {
  const output = [
    result.error?.message,
    result.signal ? `terminated by ${result.signal}` : null,
    result.stderr,
    result.stdout,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  return output || "npm install failed";
}

function formatBundledRuntimeDepsInstallElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function emitBundledRuntimeDepsOutputProgress(
  chunk: Buffer,
  stream: "stdout" | "stderr",
  packageManager: BundledRuntimeDepsPackageManager,
  onProgress: ((message: string) => void) | undefined,
): void {
  if (!onProgress) {
    return;
  }
  const lines = chunk
    .toString("utf8")
    .split(/\r\n|\n|\r/u)
    .map((line) => sanitizeTerminalText(line).trim())
    .filter((line) => line.length > 0)
    .slice(-3);
  for (const line of lines) {
    onProgress(`${packageManager} ${stream}: ${line}`);
  }
}

type BundledRuntimeDepsInstallContext = {
  installExecutionRoot: string;
  installSpecs: string[];
  installEnv: NodeJS.ProcessEnv;
  runner: BundledRuntimeDepsPackageManagerRunner;
  isolatedExecutionRoot: boolean;
  cleanInstallExecutionRoot: boolean;
};

function createBundledRuntimeDepsInstallContext(params: {
  installRoot: string;
  installExecutionRoot?: string;
  installSpecs: readonly string[];
  env: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}): BundledRuntimeDepsInstallContext {
  const installExecutionRoot = params.installExecutionRoot ?? params.installRoot;
  const isolatedExecutionRoot =
    path.resolve(installExecutionRoot) !== path.resolve(params.installRoot);
  const cleanInstallExecutionRoot =
    isolatedExecutionRoot &&
    shouldCleanBundledRuntimeDepsInstallExecutionRoot({
      installRoot: params.installRoot,
      installExecutionRoot,
    });

  fs.mkdirSync(params.installRoot, { recursive: true });
  fs.mkdirSync(installExecutionRoot, { recursive: true });
  const diskWarning = createLowDiskSpaceWarning({
    targetPath: installExecutionRoot,
    purpose: "bundled plugin runtime dependency staging",
  });
  if (diskWarning) {
    params.warn?.(diskWarning);
  }
  ensureNpmInstallExecutionManifest(installExecutionRoot, params.installSpecs);
  const installEnv = createBundledRuntimeDepsInstallEnv(params.env, {
    cacheDir: path.join(installExecutionRoot, ".openclaw-npm-cache"),
  });
  const runner = resolveBundledRuntimeDepsPackageManagerRunner({
    installExecutionRoot,
    env: installEnv,
    npmArgs: createBundledRuntimeDepsInstallArgs(),
  });

  return {
    installExecutionRoot,
    installSpecs: normalizeRuntimeDepSpecs(params.installSpecs),
    installEnv,
    runner,
    isolatedExecutionRoot,
    cleanInstallExecutionRoot,
  };
}

function finalizeBundledRuntimeDepsInstall(params: {
  installRoot: string;
  context: BundledRuntimeDepsInstallContext;
}): void {
  const { context } = params;
  assertBundledRuntimeDepsInstalled(context.installExecutionRoot, context.installSpecs);
  if (context.isolatedExecutionRoot) {
    const stagedNodeModulesDir = path.join(context.installExecutionRoot, "node_modules");
    if (!fs.existsSync(stagedNodeModulesDir)) {
      throw new Error(`${context.runner.packageManager} install did not produce node_modules`);
    }
    const targetNodeModulesDir = path.join(params.installRoot, "node_modules");
    replaceNodeModulesDir(targetNodeModulesDir, stagedNodeModulesDir);
    assertBundledRuntimeDepsInstalled(params.installRoot, context.installSpecs);
  }
  removeLegacyRuntimeDepsManifest(params.installRoot);
}

function cleanupBundledRuntimeDepsInstallContext(context: BundledRuntimeDepsInstallContext): void {
  if (context.cleanInstallExecutionRoot) {
    fs.rmSync(context.installExecutionRoot, { recursive: true, force: true });
  }
}

async function spawnBundledRuntimeDepsInstall(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  packageManager: BundledRuntimeDepsPackageManager;
  onProgress?: (message: string) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const startedAtMs = Date.now();
    const heartbeat =
      params.onProgress &&
      setInterval(() => {
        params.onProgress?.(
          `${params.packageManager} install still running (${formatBundledRuntimeDepsInstallElapsed(Date.now() - startedAtMs)} elapsed)`,
        );
      }, BUNDLED_RUNTIME_DEPS_INSTALL_PROGRESS_INTERVAL_MS);
    heartbeat?.unref?.();
    const settle = (fn: () => void) => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      fn();
    };
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      emitBundledRuntimeDepsOutputProgress(
        chunk,
        "stdout",
        params.packageManager,
        params.onProgress,
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      emitBundledRuntimeDepsOutputProgress(
        chunk,
        "stderr",
        params.packageManager,
        params.onProgress,
      );
    });
    child.on("error", (error) => {
      settle(() => reject(new Error(formatBundledRuntimeDepsInstallError({ error }))));
    });
    child.on("close", (status, signal) => {
      if (status === 0 && !signal) {
        settle(resolve);
        return;
      }
      settle(() =>
        reject(
          new Error(
            formatBundledRuntimeDepsInstallError({
              status,
              signal,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
            }),
          ),
        ),
      );
    });
  });
}

export function installBundledRuntimeDeps(params: {
  installRoot: string;
  installExecutionRoot?: string;
  missingSpecs: string[];
  installSpecs?: string[];
  env: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}): void {
  const installSpecs = normalizeRuntimeDepSpecs(params.installSpecs ?? params.missingSpecs);
  if (installSpecs.length === 0) {
    return;
  }
  if (isRuntimeDepsPlanMaterialized(params.installRoot, installSpecs)) {
    removeLegacyRuntimeDepsManifest(params.installRoot);
    return;
  }
  const context = createBundledRuntimeDepsInstallContext({
    installRoot: params.installRoot,
    installExecutionRoot: params.installExecutionRoot,
    installSpecs,
    env: params.env,
    warn: params.warn,
  });
  try {
    const result = spawnSync(context.runner.command, context.runner.args, {
      cwd: context.installExecutionRoot,
      encoding: "utf8",
      env: context.runner.env ?? context.installEnv,
      stdio: "pipe",
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) {
      throw new Error(formatBundledRuntimeDepsInstallError(result));
    }
    finalizeBundledRuntimeDepsInstall({ installRoot: params.installRoot, context });
  } finally {
    cleanupBundledRuntimeDepsInstallContext(context);
  }
}

export async function installBundledRuntimeDepsAsync(params: {
  installRoot: string;
  installExecutionRoot?: string;
  missingSpecs: string[];
  installSpecs?: string[];
  env: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  onProgress?: (message: string) => void;
}): Promise<void> {
  const installSpecs = normalizeRuntimeDepSpecs(params.installSpecs ?? params.missingSpecs);
  if (installSpecs.length === 0) {
    return;
  }
  if (isRuntimeDepsPlanMaterialized(params.installRoot, installSpecs)) {
    removeLegacyRuntimeDepsManifest(params.installRoot);
    return;
  }
  const context = createBundledRuntimeDepsInstallContext({
    installRoot: params.installRoot,
    installExecutionRoot: params.installExecutionRoot,
    installSpecs,
    env: params.env,
    warn: params.warn,
  });
  try {
    params.onProgress?.(
      `Starting ${context.runner.packageManager} install for bundled plugin runtime deps: ${installSpecs.join(", ")}`,
    );
    await spawnBundledRuntimeDepsInstall({
      command: context.runner.command,
      args: context.runner.args,
      cwd: context.installExecutionRoot,
      env: context.runner.env ?? context.installEnv,
      packageManager: context.runner.packageManager,
      onProgress: params.onProgress,
    });
    finalizeBundledRuntimeDepsInstall({ installRoot: params.installRoot, context });
  } finally {
    cleanupBundledRuntimeDepsInstallContext(context);
  }
}

export function repairBundledRuntimeDepsInstallRoot(params: {
  installRoot: string;
  missingSpecs: string[];
  installSpecs: string[];
  env: NodeJS.ProcessEnv;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
  warn?: (message: string) => void;
}): { installSpecs: string[] } {
  return withBundledRuntimeDepsInstallRootLock(params.installRoot, () => {
    const installSpecs = normalizeRuntimeDepSpecs(params.installSpecs);
    const install =
      params.installDeps ??
      ((installParams) =>
        installBundledRuntimeDeps({
          installRoot: installParams.installRoot,
          missingSpecs: installParams.missingSpecs,
          installSpecs: installParams.installSpecs,
          env: params.env,
          warn: params.warn,
        }));
    const finishActivity = beginBundledRuntimeDepsInstall({
      installRoot: params.installRoot,
      missingSpecs: installSpecs,
      installSpecs,
    });
    ensureNpmInstallExecutionManifest(params.installRoot, installSpecs);
    try {
      install({
        installRoot: params.installRoot,
        missingSpecs: installSpecs,
        installSpecs,
      });
    } finally {
      finishActivity();
    }
    removeLegacyRuntimeDepsManifest(params.installRoot);
    return { installSpecs };
  });
}

export async function repairBundledRuntimeDepsInstallRootAsync(params: {
  installRoot: string;
  missingSpecs: string[];
  installSpecs: string[];
  env: NodeJS.ProcessEnv;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => Promise<void>;
  warn?: (message: string) => void;
  onProgress?: (message: string) => void;
}): Promise<{ installSpecs: string[] }> {
  return await withBundledRuntimeDepsInstallRootLockAsync(params.installRoot, async () => {
    const installSpecs = normalizeRuntimeDepSpecs(params.installSpecs);
    const install =
      params.installDeps ??
      ((installParams) =>
        installBundledRuntimeDepsAsync({
          installRoot: installParams.installRoot,
          missingSpecs: installParams.missingSpecs,
          installSpecs: installParams.installSpecs,
          env: params.env,
          warn: params.warn,
          onProgress: params.onProgress,
        }));
    const finishActivity = beginBundledRuntimeDepsInstall({
      installRoot: params.installRoot,
      missingSpecs: installSpecs,
      installSpecs,
    });
    removeLegacyRuntimeDepsManifest(params.installRoot);
    ensureNpmInstallExecutionManifest(params.installRoot, installSpecs);
    try {
      await install({
        installRoot: params.installRoot,
        missingSpecs: installSpecs,
        installSpecs,
      });
    } finally {
      finishActivity();
    }
    removeLegacyRuntimeDepsManifest(params.installRoot);
    return { installSpecs };
  });
}

export function ensureBundledPluginRuntimeDeps(params: {
  pluginId: string;
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
}): BundledRuntimeDepsEnsureResult {
  if (
    params.config &&
    !isBundledPluginConfiguredForRuntimeDeps({
      config: params.config,
      pluginId: params.pluginId,
      pluginDir: params.pluginRoot,
    })
  ) {
    return createBundledRuntimeDepsEnsureResult([]);
  }
  const packageJson = readJsonObject(path.join(params.pluginRoot, "package.json"));
  if (!packageJson) {
    return createBundledRuntimeDepsEnsureResult([]);
  }
  const pluginDeps = Object.entries(collectRuntimeDeps(packageJson))
    .map(([name, rawVersion]) => parseInstallableRuntimeDep(name, rawVersion))
    .filter((entry): entry is { name: string; version: string } => Boolean(entry));
  const pluginDepEntries = pluginDeps.map((dep) => ({
    name: dep.name,
    version: dep.version,
    pluginIds: [params.pluginId],
  }));

  const installRootPlan = resolveBundledRuntimeDependencyInstallRootPlan(params.pluginRoot, {
    env: params.env,
  });
  const installRoot = installRootPlan.installRoot;
  const packageRoot = resolveBundledRuntimeDependencyPackageRoot(params.pluginRoot);
  const usePackageLevelPlan =
    packageRoot && path.resolve(installRoot) !== path.resolve(params.pluginRoot);
  let deps = pluginDepEntries;
  if (usePackageLevelPlan && packageRoot) {
    const packagePlan = collectBundledPluginRuntimeDeps({
      extensionsDir: path.dirname(params.pluginRoot),
      ...(params.config ? { config: params.config } : {}),
    });
    if (packagePlan.conflicts.length === 0 && packagePlan.deps.length > 0) {
      deps = mergeRuntimeDepEntries([
        ...packagePlan.deps,
        ...collectMirroredPackageRuntimeDeps(packageRoot),
      ]);
    } else {
      deps = mergeRuntimeDepEntries([
        ...pluginDepEntries,
        ...collectMirroredPackageRuntimeDeps(packageRoot),
      ]);
    }
  }
  if (deps.length === 0) {
    return createBundledRuntimeDepsEnsureResult([]);
  }
  const plan = createBundledRuntimeDepsPlan({
    deps,
    conflicts: [],
    installRootPlan,
  });
  return withBundledRuntimeDepsInstallRootLock(installRoot, () => {
    const installSpecs = plan.installSpecs;
    if (isRuntimeDepsPlanMaterialized(installRoot, installSpecs)) {
      removeLegacyRuntimeDepsManifest(installRoot);
      return createBundledRuntimeDepsEnsureResult([]);
    }
    const isPluginRootInstall = path.resolve(installRoot) === path.resolve(params.pluginRoot);
    const installExecutionRoot = isPluginRootInstall
      ? path.join(installRoot, PLUGIN_ROOT_INSTALL_STAGE_DIR)
      : undefined;
    removeLegacyRuntimeDepsManifest(installRoot);

    const install =
      params.installDeps ??
      ((installParams) => {
        return installBundledRuntimeDeps({
          installRoot: installParams.installRoot,
          installExecutionRoot: installParams.installExecutionRoot,
          missingSpecs: installParams.installSpecs ?? installParams.missingSpecs,
          installSpecs: installParams.installSpecs,
          env: params.env,
        });
      });
    const finishActivity = beginBundledRuntimeDepsInstall({
      installRoot,
      missingSpecs: installSpecs,
      installSpecs,
      pluginId: params.pluginId,
    });
    if (!installExecutionRoot) {
      ensureNpmInstallExecutionManifest(installRoot, installSpecs);
    }
    try {
      install({
        installRoot,
        ...(installExecutionRoot ? { installExecutionRoot } : {}),
        missingSpecs: installSpecs,
        installSpecs,
      });
    } finally {
      finishActivity();
    }
    removeLegacyRuntimeDepsManifest(installRoot);
    return createBundledRuntimeDepsEnsureResult(installSpecs);
  });
}
