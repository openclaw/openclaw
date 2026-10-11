// Static payload checks for installed plugins after a core update swaps package files.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { pathExists } from "../infra/fs-safe.js";
import { resolveUserPath } from "../utils.js";
import { detectBundleManifestFormat, loadBundleManifest } from "./bundle-manifest.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginBundleFormat } from "./manifest-types.js";
import { resolvePackageExtensionEntries, type PackageManifest } from "./manifest.js";
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
  const { pluginId, installPath, packagePayload } = params;
  return {
    pluginId,
    installPath,
    reason: `${packagePayload.status}-package-json`,
    detail:
      packagePayload.status === "unreadable"
        ? `Could not read package.json at ${path.join(installPath, "package.json")}: ${packagePayload.error}`
        : packagePayload.status === "invalid"
          ? `Could not parse package.json: ${packagePayload.error}`
          : `package.json is missing under ${installPath}`,
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
  if (extensionResolution.status !== "missing") {
    const extensionValidation =
      extensionResolution.status === "ok"
        ? await validatePackageExtensionEntriesForInstall({
            packageDir: params.installPath,
            extensions: extensionResolution.entries,
            manifest: params.manifest,
          })
        : {
            ok: false,
            error:
              extensionResolution.status === "invalid"
                ? extensionResolution.error
                : "package.json openclaw.extensions is empty",
          };
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
