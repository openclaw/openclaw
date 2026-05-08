import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { areBundledPluginsDisabled, resolveBundledPluginsDir } from "./bundled-dir.js";
import { fileSignatureMatches, fileSignatureMatchesAsync } from "./installed-plugin-index-hash.js";
import { hasOptionalMissingPluginManifestFile } from "./installed-plugin-index-manifest.js";
import {
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
} from "./installed-plugin-index-record-reader.js";
import {
  inspectPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  refreshPersistedInstalledPluginIndex,
  type InstalledPluginIndexStoreInspection,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store.js";
import {
  getInstalledPluginRecord,
  extractPluginInstallRecordsFromInstalledPluginIndex,
  isInstalledPluginEnabled,
  listInstalledPluginRecords,
  loadInstalledPluginIndex,
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";

export type PluginRegistrySnapshot = InstalledPluginIndex;
export type PluginRegistryRecord = InstalledPluginIndexRecord;
export type PluginRegistryInspection = InstalledPluginIndexStoreInspection;
export type PluginRegistrySnapshotSource = "provided" | "persisted" | "derived";
export type PluginRegistrySnapshotDiagnosticCode =
  | "persisted-registry-disabled"
  | "persisted-registry-missing"
  | "persisted-registry-stale-policy"
  | "persisted-registry-stale-source";

export type PluginRegistrySnapshotDiagnostic = {
  level: "info" | "warn";
  code: PluginRegistrySnapshotDiagnosticCode;
  message: string;
};

export type PluginRegistrySnapshotResult = {
  snapshot: PluginRegistrySnapshot;
  source: PluginRegistrySnapshotSource;
  diagnostics: readonly PluginRegistrySnapshotDiagnostic[];
};

export const DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV = "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY";

function formatDeprecatedPersistedRegistryDisableWarning(): string {
  return `${DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV} is a deprecated break-glass compatibility switch; use \`openclaw plugins registry --refresh\` or \`openclaw doctor --fix\` to repair registry state.`;
}

export type LoadPluginRegistryParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    index?: PluginRegistrySnapshot;
    preferPersisted?: boolean;
  };

export type GetPluginRecordParams = LoadPluginRegistryParams & {
  pluginId: string;
};

function hasEnvFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false" && value !== "no");
}

function hasMissingPersistedPluginSource(index: InstalledPluginIndex): boolean {
  return index.plugins.some((plugin) => {
    if (!plugin.enabled) {
      return false;
    }
    return (
      !fs.existsSync(plugin.rootDir) ||
      (!hasOptionalMissingPluginManifestFile(plugin) && !fs.existsSync(plugin.manifestPath)) ||
      (plugin.source ? !fs.existsSync(plugin.source) : false) ||
      (plugin.setupSource ? !fs.existsSync(plugin.setupSource) : false)
    );
  });
}

async function existsAsync(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasMissingPersistedPluginSourceAsync(index: InstalledPluginIndex): Promise<boolean> {
  for (const plugin of index.plugins) {
    if (!plugin.enabled) {
      continue;
    }
    const requiredPaths: string[] = [plugin.rootDir];
    if (!hasOptionalMissingPluginManifestFile(plugin)) {
      requiredPaths.push(plugin.manifestPath);
    }
    if (plugin.source) {
      requiredPaths.push(plugin.source);
    }
    if (plugin.setupSource) {
      requiredPaths.push(plugin.setupSource);
    }
    const presence = await Promise.all(requiredPaths.map(existsAsync));
    if (presence.some((present) => !present)) {
      return true;
    }
  }
  return false;
}

function resolveComparablePath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function resolveComparablePathAsync(filePath: string): Promise<string> {
  try {
    return await fsPromises.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const relative = path.relative(
    resolveComparablePath(parentPath),
    resolveComparablePath(childPath),
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isPathInsideOrEqualAsync(childPath: string, parentPath: string): Promise<boolean> {
  const [resolvedParent, resolvedChild] = await Promise.all([
    resolveComparablePathAsync(parentPath),
    resolveComparablePathAsync(childPath),
  ]);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasMismatchedPersistedBundledPluginRoot(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv,
): boolean {
  const bundledPluginsDir = resolveBundledPluginsDir(env);
  if (!bundledPluginsDir) {
    return false;
  }
  return index.plugins.some(
    (plugin) =>
      plugin.origin === "bundled" && !isPathInsideOrEqual(plugin.rootDir, bundledPluginsDir),
  );
}

async function hasMismatchedPersistedBundledPluginRootAsync(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const bundledPluginsDir = resolveBundledPluginsDir(env);
  if (!bundledPluginsDir) {
    return false;
  }
  for (const plugin of index.plugins) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    if (!(await isPathInsideOrEqualAsync(plugin.rootDir, bundledPluginsDir))) {
      return true;
    }
  }
  return false;
}

function hashExistingFile(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

async function hashExistingFileAsync(filePath: string): Promise<string | null> {
  try {
    const data = await fsPromises.readFile(filePath);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
}

function resolveRecordPackageJsonPath(plugin: InstalledPluginIndexRecord): string | null {
  const packageJsonPath = plugin.packageJson?.path;
  if (!packageJsonPath) {
    return null;
  }
  const rootDir = plugin.rootDir || path.dirname(plugin.manifestPath);
  const resolved = path.resolve(rootDir, packageJsonPath);
  const relative = path.relative(rootDir, resolved);
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : resolved;
}

function hasStalePersistedPluginMetadata(index: InstalledPluginIndex): boolean {
  return index.plugins.some((plugin) => {
    if (!hasOptionalMissingPluginManifestFile(plugin)) {
      const manifestSignatureMatches = fileSignatureMatches(
        plugin.manifestPath,
        plugin.manifestFile,
      );
      if (manifestSignatureMatches !== true) {
        const manifestHash = hashExistingFile(plugin.manifestPath);
        if (manifestHash && manifestHash !== plugin.manifestHash) {
          return true;
        }
      }
    }
    const packageJsonPath = resolveRecordPackageJsonPath(plugin);
    if (!plugin.packageJson?.hash) {
      return false;
    }
    if (!packageJsonPath) {
      return true;
    }
    const packageJsonSignatureMatches = fileSignatureMatches(
      packageJsonPath,
      plugin.packageJson.fileSignature,
    );
    if (packageJsonSignatureMatches === true && plugin.origin === "bundled") {
      return false;
    }
    if (packageJsonSignatureMatches === false) {
      return hashExistingFile(packageJsonPath) !== plugin.packageJson.hash;
    }
    // Fast same-size rewrites can preserve observable stat fields on some filesystems.
    const packageJsonHash = hashExistingFile(packageJsonPath);
    return packageJsonHash !== plugin.packageJson.hash;
  });
}

async function isPluginMetadataStaleAsync(plugin: InstalledPluginIndexRecord): Promise<boolean> {
  if (!hasOptionalMissingPluginManifestFile(plugin)) {
    const manifestSignatureMatches = await fileSignatureMatchesAsync(
      plugin.manifestPath,
      plugin.manifestFile,
    );
    if (manifestSignatureMatches !== true) {
      const manifestHash = await hashExistingFileAsync(plugin.manifestPath);
      if (manifestHash && manifestHash !== plugin.manifestHash) {
        return true;
      }
    }
  }
  const packageJsonPath = resolveRecordPackageJsonPath(plugin);
  if (!plugin.packageJson?.hash) {
    return false;
  }
  if (!packageJsonPath) {
    return true;
  }
  const packageJsonSignatureMatches = await fileSignatureMatchesAsync(
    packageJsonPath,
    plugin.packageJson.fileSignature,
  );
  if (packageJsonSignatureMatches === true && plugin.origin === "bundled") {
    return false;
  }
  if (packageJsonSignatureMatches === false) {
    return (await hashExistingFileAsync(packageJsonPath)) !== plugin.packageJson.hash;
  }
  // Fast same-size rewrites can preserve observable stat fields on some filesystems.
  const packageJsonHash = await hashExistingFileAsync(packageJsonPath);
  return packageJsonHash !== plugin.packageJson.hash;
}

async function hasStalePersistedPluginMetadataAsync(index: InstalledPluginIndex): Promise<boolean> {
  for (const plugin of index.plugins) {
    if (await isPluginMetadataStaleAsync(plugin)) {
      return true;
    }
  }
  return false;
}

function loadSnapshotInstallRecords(params: LoadPluginRegistryParams, env: NodeJS.ProcessEnv) {
  return loadInstalledPluginIndexInstallRecordsSync({
    env,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    ...(params.filePath
      ? { filePath: params.filePath }
      : params.pluginIndexFilePath
        ? { filePath: params.pluginIndexFilePath }
        : {}),
  });
}

function loadSnapshotInstallRecordsAsync(
  params: LoadPluginRegistryParams,
  env: NodeJS.ProcessEnv,
): Promise<ReturnType<typeof loadInstalledPluginIndexInstallRecordsSync>> {
  return loadInstalledPluginIndexInstallRecords({
    env,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    ...(params.filePath
      ? { filePath: params.filePath }
      : params.pluginIndexFilePath
        ? { filePath: params.pluginIndexFilePath }
        : {}),
  });
}

function hasRecoveredInstallRecordsMissingFromPersistedIndex(
  index: InstalledPluginIndex,
  installRecords: ReturnType<typeof loadInstalledPluginIndexInstallRecordsSync>,
): boolean {
  const persistedRecords = extractPluginInstallRecordsFromInstalledPluginIndex(index);
  const persistedPluginIds = new Set(index.plugins.map((plugin) => plugin.pluginId));
  return Object.keys(installRecords).some(
    (pluginId) => !persistedRecords[pluginId] || !persistedPluginIds.has(pluginId),
  );
}

export function loadPluginRegistrySnapshotWithMetadata(
  params: LoadPluginRegistryParams = {},
): PluginRegistrySnapshotResult {
  if (params.index) {
    return {
      snapshot: params.index,
      source: "provided",
      diagnostics: [],
    };
  }

  const env = params.env ?? process.env;
  const diagnostics: PluginRegistrySnapshotDiagnostic[] = [];
  const disabledByCaller = params.preferPersisted === false;
  const disabledByEnv = hasEnvFlag(env, DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV);
  const persistedReadsEnabled = !disabledByCaller && !disabledByEnv;
  const persistedInstallRecordReadsEnabled = !disabledByEnv;
  let persistedIndex: InstalledPluginIndex | null = null;
  if (persistedInstallRecordReadsEnabled) {
    persistedIndex = readPersistedInstalledPluginIndexSync(params);
    if (persistedReadsEnabled && persistedIndex) {
      if (
        params.config &&
        persistedIndex.policyHash !== resolveInstalledPluginIndexPolicyHash(params.config)
      ) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-policy",
          message:
            "Persisted plugin registry policy does not match current config; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasMissingPersistedPluginSource(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry points at missing plugin files; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasMismatchedPersistedBundledPluginRoot(persistedIndex, env)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry points at a different bundled plugin tree; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (hasStalePersistedPluginMetadata(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry metadata no longer matches plugin manifest or package files; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (
        hasRecoveredInstallRecordsMissingFromPersistedIndex(
          persistedIndex,
          loadSnapshotInstallRecords(params, env),
        )
      ) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry is missing recoverable managed npm plugins; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else {
        return {
          snapshot: persistedIndex,
          source: "persisted",
          diagnostics,
        };
      }
    } else if (persistedReadsEnabled) {
      diagnostics.push({
        level: "info",
        code: "persisted-registry-missing",
        message: "Persisted plugin registry is missing or invalid; using derived plugin index.",
      });
    }
  } else {
    diagnostics.push({
      level: "warn",
      code: "persisted-registry-disabled",
      message: disabledByEnv
        ? `${formatDeprecatedPersistedRegistryDisableWarning()} Using legacy derived plugin index.`
        : "Persisted plugin registry reads are disabled by the caller; using derived plugin index.",
    });
  }

  return {
    snapshot: loadInstalledPluginIndex({
      ...params,
      ...(persistedInstallRecordReadsEnabled
        ? {}
        : { installRecords: params.installRecords ?? {} }),
    }),
    source: "derived",
    diagnostics,
  };
}

// Inflight dedup for the async path: when one async caller is already computing
// a snapshot for the same params, others await the same Promise instead of
// kicking off a parallel walk that would compete on the same sync-FS work.
type AsyncRegistrySnapshotInflight = {
  key: string;
  promise: Promise<PluginRegistrySnapshotResult>;
};
let registrySnapshotInflight: AsyncRegistrySnapshotInflight | null = null;

function buildAsyncRegistrySnapshotKey(params: LoadPluginRegistryParams): string {
  // Dedup concurrent async calls only when every behavior-affecting input
  // matches; otherwise distinct callers must each compute their own snapshot.
  const env = params.env ?? process.env;
  const policyHash = params.config ? resolveInstalledPluginIndexPolicyHash(params.config) : "";
  const installRecordsKey = params.installRecords
    ? Object.keys(params.installRecords).sort().join(",")
    : "";
  const bundledRoot = resolveBundledPluginsDir(env) ?? "";
  return [
    params.stateDir ?? "",
    params.filePath ?? "",
    params.pluginIndexFilePath ?? "",
    params.workspaceDir ?? "",
    params.preferPersisted === undefined ? "u" : String(params.preferPersisted),
    policyHash,
    installRecordsKey,
    bundledRoot,
    hasEnvFlag(env, DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV) ? "1" : "0",
    areBundledPluginsDisabled(env) ? "1" : "0",
  ].join("|");
}

async function loadPluginRegistrySnapshotWithMetadataAsyncImpl(
  params: LoadPluginRegistryParams,
): Promise<PluginRegistrySnapshotResult> {
  const env = params.env ?? process.env;
  const diagnostics: PluginRegistrySnapshotDiagnostic[] = [];
  const disabledByCaller = params.preferPersisted === false;
  const disabledByEnv = hasEnvFlag(env, DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV);
  const persistedReadsEnabled = !disabledByCaller && !disabledByEnv;
  const persistedInstallRecordReadsEnabled = !disabledByEnv;
  let persistedIndex: InstalledPluginIndex | null = null;
  if (persistedInstallRecordReadsEnabled) {
    persistedIndex = await readPersistedInstalledPluginIndex(params);
    if (persistedReadsEnabled && persistedIndex) {
      if (
        params.config &&
        persistedIndex.policyHash !== resolveInstalledPluginIndexPolicyHash(params.config)
      ) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-policy",
          message:
            "Persisted plugin registry policy does not match current config; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (await hasMissingPersistedPluginSourceAsync(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry points at missing plugin files; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (await hasMismatchedPersistedBundledPluginRootAsync(persistedIndex, env)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry points at a different bundled plugin tree; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (await hasStalePersistedPluginMetadataAsync(persistedIndex)) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry metadata no longer matches plugin manifest or package files; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else if (
        hasRecoveredInstallRecordsMissingFromPersistedIndex(
          persistedIndex,
          await loadSnapshotInstallRecordsAsync(params, env),
        )
      ) {
        diagnostics.push({
          level: "warn",
          code: "persisted-registry-stale-source",
          message:
            "Persisted plugin registry is missing recoverable managed npm plugins; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry.",
        });
      } else {
        return {
          snapshot: persistedIndex,
          source: "persisted",
          diagnostics,
        };
      }
    } else if (persistedReadsEnabled) {
      diagnostics.push({
        level: "info",
        code: "persisted-registry-missing",
        message: "Persisted plugin registry is missing or invalid; using derived plugin index.",
      });
    }
  } else {
    diagnostics.push({
      level: "warn",
      code: "persisted-registry-disabled",
      message: disabledByEnv
        ? `${formatDeprecatedPersistedRegistryDisableWarning()} Using legacy derived plugin index.`
        : "Persisted plugin registry reads are disabled by the caller; using derived plugin index.",
    });
  }

  // Derived-path fallback. The walker is still sync — yield once to the event
  // loop so other I/O (notably WhatsApp keepalives) can interleave between the
  // freshness checks above and the heavier discovery walk below.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  return {
    snapshot: loadInstalledPluginIndex({
      ...params,
      ...(persistedInstallRecordReadsEnabled
        ? {}
        : { installRecords: params.installRecords ?? {} }),
    }),
    source: "derived",
    diagnostics,
  };
}

export function loadPluginRegistrySnapshotWithMetadataAsync(
  params: LoadPluginRegistryParams = {},
): Promise<PluginRegistrySnapshotResult> {
  if (params.index) {
    return Promise.resolve({
      snapshot: params.index,
      source: "provided",
      diagnostics: [],
    });
  }
  const key = buildAsyncRegistrySnapshotKey(params);
  const existing = registrySnapshotInflight;
  if (existing && existing.key === key) {
    return existing.promise;
  }
  const promise = loadPluginRegistrySnapshotWithMetadataAsyncImpl(params).finally(() => {
    if (registrySnapshotInflight && registrySnapshotInflight.key === key) {
      registrySnapshotInflight = null;
    }
  });
  registrySnapshotInflight = { key, promise };
  return promise;
}

function resolveSnapshot(params: LoadPluginRegistryParams = {}): PluginRegistrySnapshot {
  return loadPluginRegistrySnapshotWithMetadata(params).snapshot;
}

async function resolveSnapshotAsync(
  params: LoadPluginRegistryParams = {},
): Promise<PluginRegistrySnapshot> {
  return (await loadPluginRegistrySnapshotWithMetadataAsync(params)).snapshot;
}

export function loadPluginRegistrySnapshot(
  params: LoadPluginRegistryParams = {},
): PluginRegistrySnapshot {
  return resolveSnapshot(params);
}

export function loadPluginRegistrySnapshotAsync(
  params: LoadPluginRegistryParams = {},
): Promise<PluginRegistrySnapshot> {
  return resolveSnapshotAsync(params);
}

export function listPluginRecords(
  params: LoadPluginRegistryParams = {},
): readonly PluginRegistryRecord[] {
  return listInstalledPluginRecords(resolveSnapshot(params));
}

export async function listPluginRecordsAsync(
  params: LoadPluginRegistryParams = {},
): Promise<readonly PluginRegistryRecord[]> {
  return listInstalledPluginRecords(await resolveSnapshotAsync(params));
}

export function getPluginRecord(params: GetPluginRecordParams): PluginRegistryRecord | undefined {
  return getInstalledPluginRecord(resolveSnapshot(params), params.pluginId);
}

export async function getPluginRecordAsync(
  params: GetPluginRecordParams,
): Promise<PluginRegistryRecord | undefined> {
  return getInstalledPluginRecord(await resolveSnapshotAsync(params), params.pluginId);
}

export function isPluginEnabled(params: GetPluginRecordParams): boolean {
  return isInstalledPluginEnabled(resolveSnapshot(params), params.pluginId, params.config);
}

export async function isPluginEnabledAsync(params: GetPluginRecordParams): Promise<boolean> {
  return isInstalledPluginEnabled(
    await resolveSnapshotAsync(params),
    params.pluginId,
    params.config,
  );
}

export function inspectPluginRegistry(
  params: LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions = {},
): Promise<PluginRegistryInspection> {
  return inspectPersistedInstalledPluginIndex(params);
}

export function refreshPluginRegistry(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): Promise<PluginRegistrySnapshot> {
  return refreshPersistedInstalledPluginIndex(params);
}
