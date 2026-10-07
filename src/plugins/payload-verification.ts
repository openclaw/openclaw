// Static payload checks for installed plugins after a core update swaps package files.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { pathExists } from "../infra/fs-safe.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveUserPath } from "../utils.js";
import { detectBundleManifestFormat, loadBundleManifest } from "./bundle-manifest.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginBundleFormat } from "./manifest-types.js";
import {
  loadPluginManifest,
  resolvePackageExtensionEntries,
  type PackageManifest,
} from "./manifest.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubInstall,
  resolveTrustedSourceLinkedOfficialNpmInstall,
} from "./official-external-install-records.js";
import { validatePackageExtensionEntriesForInstall } from "./package-entry-resolution.js";
import {
  auditOpenClawPeerDependencyLink,
  resolveOpenClawHostDependency,
} from "./plugin-peer-link.js";
import type { PluginVerificationFailureReason } from "./runtime-degraded-state.js";

export type PluginPayloadSmokeFailure = {
  pluginId: string;
  installPath?: string;
  reason: PluginVerificationFailureReason;
  detail: string;
};

export type PluginPayloadSmokeResult = {
  checked: string[];
  failures: PluginPayloadSmokeFailure[];
};

const TRACKED_SOURCES: ReadonlySet<string> = new Set(["npm", "clawhub", "git", "marketplace"]);

type PluginInstallBackupRecoveryResult = {
  restored: Array<{ pluginId: string; backupPath: string }>;
  failures: Array<{ pluginId: string; error: string }>;
};

/** Restores missing recorded packages without consuming their verified install backups. */
export async function restoreMissingPluginInstallBackups(params: {
  records: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<PluginInstallBackupRecoveryResult> {
  const { records, ...options } = params;
  const result: PluginInstallBackupRecoveryResult = { restored: [], failures: [] };
  for (const [pluginId, record] of Object.entries(records)) {
    const recovery = await restoreMissingPluginInstallBackup({ ...options, pluginId, record });
    if (recovery.backupPath) {
      result.restored.push({ pluginId, backupPath: recovery.backupPath });
    } else if (recovery.error) {
      result.failures.push({ pluginId, error: recovery.error });
    }
  }
  return result;
}

async function restoreMissingPluginInstallBackup(
  params: Omit<Parameters<typeof restoreMissingPluginInstallBackups>[0], "records"> & {
    pluginId: string;
    record: PluginInstallRecord;
  },
): Promise<{ backupPath?: string; error?: string }> {
  const rawInstallPath = normalizeOptionalString(params.record.installPath);
  if (!TRACKED_SOURCES.has(params.record.source) || !rawInstallPath) {
    return {};
  }
  const installPath = resolveUserPath(rawInstallPath, params.env);
  let lastError: string | undefined;
  try {
    if (await fs.lstat(installPath).catch(() => null)) {
      return {};
    }
    const backupRoot = path.join(path.dirname(installPath), ".openclaw-install-backups");
    const rootStat = await fs.lstat(backupRoot).catch(() => null);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      return {};
    }
    const prefix = `${path.basename(installPath)}-`;
    const backups = (await fs.readdir(backupRoot, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith(prefix) &&
          /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(entry.name.slice(prefix.length)),
      )
      .toSorted((left, right) => left.name.localeCompare(right.name));
    if (backups.length === 0) {
      return {};
    }
    const packageNames: Array<string | undefined> = [
      params.record.resolvedName,
      params.record.clawhubPackage,
    ].filter((name) => name !== undefined);
    for (const spec of [params.record.spec, params.record.resolvedSpec]) {
      if (spec === undefined) {
        continue;
      }
      if (params.record.source === "clawhub") {
        packageNames.push(parseClawHubPluginSpec(spec)?.name ?? parseRegistryNpmSpec(spec)?.name);
      } else if (
        params.record.source === "npm" &&
        !params.record.artifactKind &&
        !params.record.sourcePath
      ) {
        packageNames.push(parseRegistryNpmSpec(spec)?.name);
      }
    }
    const { installPackageDir } = await import("../infra/install-package-dir.js");
    for (const backup of backups) {
      const backupPath = path.join(backupRoot, backup.name);
      const result = await installPackageDir({
        sourceDir: backupPath,
        targetDir: installPath,
        mode: "install",
        hasDeps: false,
        timeoutMs: 0,
        copyErrorPrefix: "Failed to restore plugin backup",
        depsLogMessage: "",
        beforePersistentApply: params.assertCurrent,
        authorizeMutation: async () => {
          await params.beforePersistentEffect?.();
          params.assertCurrent();
          if (await fs.lstat(installPath).catch(() => null)) {
            throw new Error(`Install path appeared during backup recovery: ${installPath}`);
          }
        },
        afterInstall: async (stagedPath) => {
          const manifest = loadPluginManifest(stagedPath);
          const payload = await readPackagePayloadManifest(stagedPath);
          const version = params.record.version ?? params.record.resolvedVersion;
          if (
            !manifest.ok ||
            manifest.manifest.id !== params.pluginId ||
            payload.status !== "present" ||
            !payload.manifest.name ||
            packageNames.some((name) => name !== payload.manifest.name) ||
            !version ||
            payload.manifest.version !== version
          ) {
            return {
              ok: false,
              error: `Backup ${backupPath} does not match the recorded plugin identity and version.`,
            };
          }
          const smoke = await runPluginPayloadSmokeCheck({
            records: { [params.pluginId]: { ...params.record, installPath: stagedPath } },
            env: params.env,
          });
          return smoke.failures.length
            ? { ok: false, error: smoke.failures.map((failure) => failure.detail).join("; ") }
            : { ok: true };
        },
      });
      params.assertCurrent();
      if (result.ok) {
        return { backupPath };
      }
      lastError = result.error;
    }
  } catch (error) {
    params.assertCurrent();
    lastError = error instanceof Error ? error.message : String(error);
  }
  return lastError ? { error: lastError } : {};
}

export type MissingPluginInstallPayload = {
  pluginId: string;
  installPath?: string;
  reason: "missing-install-path" | "missing-package-dir" | "missing-package-json";
};

export function isPayloadMissing(env: NodeJS.ProcessEnv, rawInstallPath?: string): boolean {
  const installPath = normalizeOptionalString(rawInstallPath);
  if (!installPath) {
    return true;
  }
  const resolved = resolveUserPath(installPath, env);
  const bundleFormat = detectBundleManifestFormat(resolved);
  return (
    !existsSync(path.join(resolved, "package.json")) &&
    (!bundleFormat || !loadBundleManifest({ rootDir: resolved, bundleFormat }).ok)
  );
}

/** Finds tracked install records whose package payload is absent on disk. */
export async function collectMissingPluginInstallPayloads(params: {
  records: Record<string, PluginInstallRecord>;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<MissingPluginInstallPayload[]> {
  const env = params.env ?? process.env;
  const normalizedPluginConfig = params.config
    ? normalizePluginsConfig(params.config.plugins)
    : undefined;
  const missing: MissingPluginInstallPayload[] = [];
  for (const [pluginId, record] of Object.entries(params.records).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!TRACKED_SOURCES.has(record.source)) {
      continue;
    }
    const officialNpmSpec = resolveTrustedSourceLinkedOfficialNpmInstall({
      pluginId,
      record,
    })?.npmSpec;
    const officialClawHubSpec = resolveTrustedSourceLinkedOfficialClawHubInstall({
      pluginId,
      record,
    })?.clawhubSpec;
    if (normalizedPluginConfig && params.config) {
      const enableState = resolveEffectiveEnableState({
        id: pluginId,
        origin: "global",
        config: normalizedPluginConfig,
        rootConfig: params.config,
      });
      if (!enableState.enabled && !officialNpmSpec && !officialClawHubSpec) {
        continue;
      }
    }
    const rawInstallPath = normalizeOptionalString(record.installPath);
    if (!rawInstallPath) {
      missing.push({ pluginId, reason: "missing-install-path" });
      continue;
    }
    const installPath = resolveUserPath(rawInstallPath, env);
    if (!(await pathExists(installPath))) {
      missing.push({ pluginId, installPath, reason: "missing-package-dir" });
      continue;
    }
    const bundlePayload = resolveBundleInstallRecordPayload({ record, installPath });
    if (bundlePayload.isBundlePayload) {
      if (await hasNativePackageInstallPayload(installPath)) {
        continue;
      }
      const bundleFailure = validateBundleInstallRecordPayload({
        pluginId,
        installPath,
        bundleFormat: bundlePayload.bundleFormat,
      });
      if (bundleFailure) {
        missing.push({ pluginId, installPath, reason: "missing-package-json" });
      }
      continue;
    }
    if (isPayloadMissing(env, record.installPath)) {
      missing.push({ pluginId, installPath, reason: "missing-package-json" });
    }
  }
  return missing;
}

/** Check package entries and bundle manifests without executing plugins before Gateway restart. */
export async function runPluginPayloadSmokeCheck(params: {
  records: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
  installSourceProvenance?: "authoritative" | "manifest-only";
}): Promise<PluginPayloadSmokeResult> {
  const checked: string[] = [];
  const failures: PluginPayloadSmokeFailure[] = [];

  for (const [pluginId, record] of Object.entries(params.records).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!record || typeof record !== "object" || !TRACKED_SOURCES.has(record.source)) {
      continue;
    }
    const rawInstallPath = normalizeOptionalString(record.installPath);
    checked.push(pluginId);
    if (!rawInstallPath) {
      failures.push({
        pluginId,
        reason: "missing-install-path",
        detail: "Install path is missing from the plugin install record.",
      });
      continue;
    }
    const installPath = resolveUserPath(rawInstallPath, params.env);

    const dirStat = await safeStat(installPath);
    if (!dirStat?.isDirectory()) {
      failures.push({
        pluginId,
        installPath,
        reason: "missing-package-dir",
        detail: `Install dir is missing: ${installPath}`,
      });
      continue;
    }

    const bundlePayload = resolveBundleInstallRecordPayload({ record, installPath });
    const packagePayload = await readPackagePayloadManifest(installPath);
    if (packagePayload.status === "present") {
      const usePackagePayload =
        !bundlePayload.isBundlePayload || hasNativePackageMetadata(packagePayload.manifest);
      if (usePackagePayload) {
        failures.push(
          ...(await validatePackagePayload({
            pluginId,
            installPath,
            manifest: packagePayload.manifest,
            installSource: record.source,
            installSourceIsAuthoritative: params.installSourceProvenance !== "manifest-only",
          })),
        );
        continue;
      }
    } else if (!bundlePayload.isBundlePayload) {
      failures.push(formatPackagePayloadReadFailure({ pluginId, installPath, packagePayload }));
      continue;
    }

    const bundleFailure = validateBundleInstallRecordPayload({
      pluginId,
      installPath,
      bundleFormat: bundlePayload.bundleFormat,
    });
    if (bundleFailure) {
      failures.push(bundleFailure);
    }
  }

  return { checked, failures };
}

/** Verifies the exact manifest records selected for this process. */
export async function runPluginPayloadSmokeCheckForManifestRecords(params: {
  plugins: readonly Pick<PluginManifestRecord, "id" | "rootDir" | "format">[];
  env: NodeJS.ProcessEnv;
}): Promise<PluginPayloadSmokeResult> {
  const records = Object.fromEntries(
    params.plugins.map((plugin) => [
      plugin.id,
      {
        source: plugin.format === "bundle" ? "marketplace" : "npm",
        installPath: plugin.rootDir,
        ...(plugin.format === "bundle" ? { clawhubFamily: "bundle-plugin" as const } : {}),
      } satisfies PluginInstallRecord,
    ]),
  );
  // Manifest snapshots do not carry install ownership; their synthetic npm source is not a ledger.
  return await runPluginPayloadSmokeCheck({
    records,
    env: params.env,
    installSourceProvenance: "manifest-only",
  });
}

type PackagePayloadManifest = PackageManifest & { main?: unknown };

type PackagePayloadManifestReadResult =
  | { status: "missing" }
  | { status: "unreadable"; error: string }
  | { status: "invalid"; error: string }
  | { status: "present"; manifest: PackagePayloadManifest };

async function readPackagePayloadManifest(
  installPath: string,
): Promise<PackagePayloadManifestReadResult> {
  const packageJsonPath = path.join(installPath, "package.json");
  const packageJsonStat = await safeStat(packageJsonPath);
  if (!packageJsonStat?.isFile()) {
    return { status: "missing" };
  }
  let packageJson: string;
  try {
    packageJson = await fs.readFile(packageJsonPath, "utf8");
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const manifest: unknown = JSON.parse(packageJson);
    if (!isRecord(manifest)) {
      return { status: "invalid", error: "package.json must be an object" };
    }
    return {
      status: "present",
      manifest,
    };
  } catch (err) {
    return { status: "invalid", error: err instanceof Error ? err.message : String(err) };
  }
}

function formatPackagePayloadReadFailure(params: {
  pluginId: string;
  installPath: string;
  packagePayload: Exclude<PackagePayloadManifestReadResult, { status: "present" }>;
}): PluginPayloadSmokeFailure {
  if (params.packagePayload.status === "unreadable") {
    const packageJsonPath = path.join(params.installPath, "package.json");
    return {
      pluginId: params.pluginId,
      installPath: params.installPath,
      reason: "unreadable-package-json",
      detail: `Could not read package.json at ${packageJsonPath}: ${params.packagePayload.error}`,
    };
  }
  if (params.packagePayload.status === "invalid") {
    return {
      pluginId: params.pluginId,
      installPath: params.installPath,
      reason: "invalid-package-json",
      detail: `Could not parse package.json: ${params.packagePayload.error}`,
    };
  }
  return {
    pluginId: params.pluginId,
    installPath: params.installPath,
    reason: "missing-package-json",
    detail: `package.json is missing under ${params.installPath}`,
  };
}

function hasNativePackageMetadata(manifest: PackageManifest): boolean {
  return resolvePackageExtensionEntries(manifest).status !== "missing";
}

async function hasNativePackageInstallPayload(installPath: string): Promise<boolean> {
  const packagePayload = await readPackagePayloadManifest(installPath);
  return packagePayload.status === "present" && hasNativePackageMetadata(packagePayload.manifest);
}

async function validatePackagePayload(params: {
  pluginId: string;
  installPath: string;
  manifest: PackagePayloadManifest;
  installSource: PluginInstallRecord["source"];
  installSourceIsAuthoritative: boolean;
}): Promise<PluginPayloadSmokeFailure[]> {
  const failures: PluginPayloadSmokeFailure[] = [];

  const hostDependency = resolveOpenClawHostDependency(params.manifest);
  // Older non-npm installs never guaranteed direct host links; only npm ownership can repair them.
  if (
    hostDependency &&
    (hostDependency.declaration === "peerDependencies" ||
      (params.installSourceIsAuthoritative && params.installSource === "npm"))
  ) {
    const peerIssue = await auditOpenClawPeerDependencyLink({
      packageDir: params.installPath,
      packageName: params.manifest.name ?? params.pluginId,
    });
    if (peerIssue) {
      failures.push({
        pluginId: params.pluginId,
        installPath: params.installPath,
        reason: "missing-openclaw-peer-link",
        detail: `Plugin declares ${
          hostDependency.declaration === "peerDependencies" ? "peerDependency" : "dependency"
        } "openclaw" but ${
          hostDependency.declaration === "peerDependencies" ? "peer" : "host"
        } link audit failed: ${peerIssue.reason}.`,
      });
    }
  }

  const extensionResolution = resolvePackageExtensionEntries(params.manifest);
  if (extensionResolution.status === "invalid" || extensionResolution.status === "empty") {
    failures.push({
      pluginId: params.pluginId,
      installPath: params.installPath,
      reason: "missing-extension-entry",
      detail: `Plugin extension entry validation failed: ${
        extensionResolution.status === "invalid"
          ? extensionResolution.error
          : "package.json openclaw.extensions is empty"
      }`,
    });
    return failures;
  }
  if (extensionResolution.status === "ok") {
    const extensionValidation = await validatePackageExtensionEntriesForInstall({
      packageDir: params.installPath,
      extensions: extensionResolution.entries,
      manifest: params.manifest,
    });
    if (!extensionValidation.ok) {
      failures.push({
        pluginId: params.pluginId,
        installPath: params.installPath,
        reason: "missing-extension-entry",
        detail: `Plugin extension entry validation failed: ${extensionValidation.error}`,
      });
    }

    // Native plugin loading follows the declared extensions, not npm's main.
    // Checking both would quarantine a loadable plugin or duplicate its real entry failure.
    return failures;
  }

  // Without native extension metadata, only check an explicitly declared npm
  // main. Conditional exports remain outside this static smoke-check contract.
  if (typeof params.manifest.main !== "string" || !params.manifest.main.trim()) {
    return failures;
  }
  const mainRel = params.manifest.main.trim();
  const mainPath = path.join(params.installPath, mainRel);
  const mainStat = await safeStat(mainPath);
  if (!mainStat?.isFile()) {
    failures.push({
      pluginId: params.pluginId,
      installPath: params.installPath,
      reason: "missing-main-entry",
      detail: `Plugin main entry "${mainRel}" not found at ${mainPath}`,
    });
  }
  return failures;
}

function isBundleInstallRecord(record: PluginInstallRecord): boolean {
  return (
    // SAFETY: Persisted bundle records may carry legacy format metadata outside the current type.
    (record as { format?: unknown }).format === "bundle" || record.clawhubFamily === "bundle-plugin"
  );
}

function resolveBundleInstallRecordPayload(params: {
  record: PluginInstallRecord;
  installPath: string;
}): { isBundlePayload: boolean; bundleFormat: PluginBundleFormat | null } {
  const hasBundleRecordMetadata = isBundleInstallRecord(params.record);
  if (!hasBundleRecordMetadata && params.record.source !== "marketplace") {
    return { isBundlePayload: false, bundleFormat: null };
  }
  const bundleFormat = detectBundleManifestFormat(params.installPath);
  return {
    isBundlePayload: hasBundleRecordMetadata || bundleFormat !== null,
    bundleFormat,
  };
}

function validateBundleInstallRecordPayload(params: {
  pluginId: string;
  installPath: string;
  bundleFormat: PluginBundleFormat | null;
}): PluginPayloadSmokeFailure | null {
  if (!params.bundleFormat) {
    return {
      pluginId: params.pluginId,
      installPath: params.installPath,
      reason: "missing-bundle-manifest",
      detail: `No supported bundle manifest or bundle marker found under ${params.installPath}`,
    };
  }
  const bundleManifest = loadBundleManifest({
    rootDir: params.installPath,
    bundleFormat: params.bundleFormat,
  });
  if (bundleManifest.ok) {
    return null;
  }
  return {
    pluginId: params.pluginId,
    installPath: params.installPath,
    reason: bundleManifest.error.startsWith("plugin manifest not found")
      ? "missing-bundle-manifest"
      : "invalid-bundle-manifest",
    detail: `Bundle manifest validation failed: ${bundleManifest.error}`,
  };
}

async function safeStat(target: string): Promise<import("node:fs").Stats | null> {
  return await fs.stat(target).catch(() => null);
}
