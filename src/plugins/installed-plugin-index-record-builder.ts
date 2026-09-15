/** Builds installed-index records from normalized plugin manifest registry entries. */
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString as normalizeStringField } from "@openclaw/normalization-core/string-coerce";
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { getPluginInstallRecordMapEntry } from "../config/plugin-install-record-map.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  isPluginCandidateInstallOwnerAmbiguous,
  resolvePluginCandidateInstallOwner,
} from "./candidate-install-owner.js";
import type { PluginCompatCode } from "./compat/registry.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { PluginCandidate } from "./discovery.js";
import { resolvePluginDoctorContractArtifact } from "./doctor-contract-artifact.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import type { PluginInstallSourceInfo } from "./install-source-info.js";
import { describePluginInstallSource } from "./install-source-info.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { hasOptionalMissingPluginManifestFile } from "./installed-plugin-index-manifest.js";
import type {
  InstalledPluginContributionInfo,
  InstalledPluginIndexRecord,
  InstalledPluginInstallRecordInfo,
  InstalledPluginPackageChannelInfo,
  InstalledPluginStartupInfo,
} from "./installed-plugin-index-types.js";
import { resolvePluginManifestInstallOwner } from "./manifest-install-owner.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginPackageChannel } from "./manifest.js";
import { isPathInside } from "./path-safety.js";
import { pluginCacheRealpathSync, readPluginCacheFile } from "./plugin-cache-files.js";
import { hasKind } from "./slots.js";

function buildStartupInfo(record: PluginManifestRecord): InstalledPluginStartupInfo {
  return {
    sidecar: record.activation?.onStartup === true,
    memory: hasKind(record.kind, "memory"),
    agentHarnesses: normalizeSortedUniqueStringEntries([
      ...(record.activation?.onAgentHarnesses ?? []),
      ...(record.cliBackends ?? []),
    ]),
    configPaths: normalizeSortedUniqueStringEntries(record.activation?.onConfigPaths),
  };
}

function buildContributionInfo(record: PluginManifestRecord): InstalledPluginContributionInfo {
  const contracts = Object.fromEntries(
    Object.entries(record.contracts ?? {}).map(([key, values]) => [
      key,
      normalizeSortedUniqueStringEntries(values),
    ]),
  );
  return {
    channels: normalizeSortedUniqueStringEntries(record.channels),
    channelConfigs: normalizeSortedUniqueStringEntries(Object.keys(record.channelConfigs ?? {})),
    providers: normalizeSortedUniqueStringEntries(record.providers),
    modelCatalogProviders: normalizeSortedUniqueStringEntries([
      ...Object.keys(record.modelCatalog?.providers ?? {}),
      ...Object.keys(record.modelCatalog?.aliases ?? {}),
      ...(record.modelCatalog?.suppressions ?? []).map((entry) => entry.provider),
    ]),
    modelSupportPrefixes: normalizeSortedUniqueStringEntries(record.modelSupport?.modelPrefixes),
    modelSupportPatterns: normalizeSortedUniqueStringEntries(record.modelSupport?.modelPatterns),
    autoEnableProviderIds: normalizeSortedUniqueStringEntries(
      record.autoEnableWhenConfiguredProviders,
    ),
    commandAliases: normalizeSortedUniqueStringEntries(
      record.commandAliases?.map((alias) => alias.name),
    ),
    contracts,
  };
}

/** Collects compatibility codes implied by a manifest's legacy or activation surfaces. */
export function collectPluginManifestCompatCodes(
  record: PluginManifestRecord,
): readonly PluginCompatCode[] {
  const codes: PluginCompatCode[] = [];
  if (record.activation?.onProviders?.length) {
    codes.push("activation-provider-hint");
  }
  if (record.activation?.onAgentHarnesses?.length) {
    codes.push("activation-agent-harness-hint");
  }
  if (record.activation?.onChannels?.length) {
    codes.push("activation-channel-hint");
  }
  if (record.activation?.onCommands?.length) {
    codes.push("activation-command-hint");
  }
  if (record.activation?.onRoutes?.length) {
    codes.push("activation-route-hint");
  }
  if (record.activation?.onConfigPaths?.length) {
    codes.push("activation-config-path-hint");
  }
  if (record.activation?.onCapabilities?.length) {
    codes.push("activation-capability-hint");
  }
  return normalizeSortedUniqueStringEntries(codes) as readonly PluginCompatCode[];
}

function resolvePackageJsonRecord(params: {
  candidate: PluginCandidate | undefined;
  rejectHardlinks: boolean;
}): InstalledPluginIndexRecord["packageJson"] | undefined {
  const { candidate } = params;
  if (!candidate?.packageDir) {
    return undefined;
  }
  const file = readPluginCacheFile({
    rootDir: candidate.packageDir,
    relativePath: "package.json",
    rejectHardlinks: params.rejectHardlinks,
  });
  if (!file.ok) {
    return undefined;
  }
  const rootDir =
    candidate.rootDir === candidate.packageDir
      ? file.rootRealPath
      : (pluginCacheRealpathSync(candidate.rootDir) ?? path.resolve(candidate.rootDir));
  if (!isPathInside(rootDir, file.path)) {
    return undefined;
  }
  // Persist the package entry path, even when its checked target uses another filename.
  const packageJsonPath = path.join(file.rootRealPath, "package.json");
  const relativePath = path.relative(rootDir, packageJsonPath) || "package.json";
  return {
    path: relativePath.split(path.sep).join("/"),
    hash: file.hash,
    fileSignature: file.signature,
  };
}

function describePackageInstallSource(
  candidate: PluginCandidate | undefined,
): PluginInstallSourceInfo | undefined {
  const install = candidate?.packageManifest?.install;
  if (!install) {
    return undefined;
  }
  return describePluginInstallSource(install, {
    expectedPackageName: candidate?.packageName,
  });
}

function normalizePackageChannel(
  channel: PluginPackageChannel | undefined,
): InstalledPluginPackageChannelInfo | undefined {
  const id = normalizeStringField(channel?.id);
  if (!id) {
    return undefined;
  }
  return {
    ...structuredClone(channel),
    id,
  };
}

function hashManifestlessBundleRecord(record: PluginManifestRecord): string {
  return hashJson({
    id: record.id,
    name: record.name,
    description: record.description,
    version: record.version,
    format: record.format,
    bundleFormat: record.bundleFormat,
    bundleCapabilities: record.bundleCapabilities ?? [],
    skills: record.skills ?? [],
    settingsFiles: record.settingsFiles ?? [],
    hooks: record.hooks ?? [],
  });
}

function readRecordFile(params: {
  record: PluginManifestRecord;
  filePath: string;
  boundaryRoot?: string;
  rejectHardlinks: boolean;
  required: boolean;
  diagnostics: PluginDiagnostic[];
}) {
  const rootDir = params.boundaryRoot ?? params.record.rootDir;
  let relativePath = path.relative(rootDir, params.filePath);
  if (relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    // The registry records the canonical plugin root while the manifest cache
    // can retain the lexical path through a symlinked parent directory, so the
    // lexical relative escapes the root even though the real file sits inside
    // it (#148595). Resolve both sides against the filesystem once; a manifest
    // genuinely outside the root keeps its escaping relative path and is
    // rejected exactly as before.
    try {
      const realRelative = path.relative(
        fs.realpathSync(rootDir),
        fs.realpathSync(params.filePath),
      );
      if (!realRelative.startsWith("..") && !path.isAbsolute(realRelative)) {
        relativePath = realRelative;
      }
    } catch {
      // realpath failure leaves the lexical path; the reader reports it.
    }
  }
  const file = readPluginCacheFile({
    rootDir,
    relativePath,
    rejectHardlinks: params.rejectHardlinks,
    ...(params.required && path.extname(params.filePath) === ".json"
      ? { maxBytes: 256 * 1024 }
      : {}),
  });
  if (file.ok) {
    return file;
  }
  if (params.required) {
    params.diagnostics.push({
      level: "warn",
      pluginId: params.record.id,
      source: params.filePath,
      message: `installed plugin index could not hash ${params.filePath}: ${file.failure.reason}`,
    });
  }
  return undefined;
}

function buildCandidateLookup(
  candidates: readonly PluginCandidate[],
): Map<string, PluginCandidate> {
  const bySource = new Map<string, PluginCandidate>();
  for (const candidate of candidates) {
    bySource.set(candidate.source, candidate);
  }
  return bySource;
}

export function buildInstalledPluginIndexRecords(params: {
  candidates: readonly PluginCandidate[];
  registry: PluginManifestRegistry;
  config?: OpenClawConfig;
  diagnostics: PluginDiagnostic[];
  installRecords: Record<string, InstalledPluginInstallRecordInfo>;
  /** Index builds scoped to an explicit env stamp that env's compat decisions. */
  env?: NodeJS.ProcessEnv;
}): InstalledPluginIndexRecord[] {
  const candidateBySource = buildCandidateLookup(params.candidates);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  return params.registry.plugins.map((record): InstalledPluginIndexRecord => {
    const candidate = candidateBySource.get(record.source);
    const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
      origin: record.origin,
      rootDir: record.rootDir,
      env: params.env,
    });
    const installOwner =
      candidate && isPluginCandidateInstallOwnerAmbiguous(candidate)
        ? undefined
        : (resolvePluginManifestInstallOwner(record) ??
          (candidate ? resolvePluginCandidateInstallOwner(candidate) : undefined));
    const installRecord = installOwner
      ? getPluginInstallRecordMapEntry(params.installRecords, installOwner)
      : undefined;
    const packageInstall = describePackageInstallSource(candidate);
    const packageChannel = normalizePackageChannel(
      record.packageChannel ?? candidate?.packageManifest?.channel,
    );
    const manifestless = hasOptionalMissingPluginManifestFile(record);
    const manifestFile = manifestless
      ? undefined
      : readRecordFile({
          record,
          filePath: record.manifestPath,
          rejectHardlinks,
          required: true,
          diagnostics: params.diagnostics,
        });
    const manifestHash = manifestless
      ? hashManifestlessBundleRecord(record)
      : (manifestFile?.hash ?? "");
    const doctorContractArtifact = resolvePluginDoctorContractArtifact(record);
    const doctorContractFile = doctorContractArtifact
      ? readRecordFile({
          record,
          filePath: doctorContractArtifact.modulePath,
          boundaryRoot: doctorContractArtifact.boundaryRoot,
          rejectHardlinks,
          diagnostics: params.diagnostics,
          required: false,
        })
      : undefined;
    const packageJson = resolvePackageJsonRecord({
      candidate,
      rejectHardlinks,
    });
    const enabled = resolveEffectiveEnableState({
      id: record.id,
      origin: record.origin,
      channelIds: record.channels,
      config: normalizedConfig,
      rootConfig: params.config,
      enabledByDefault: isPluginEnabledByDefaultForPlatform(record),
    }).enabled;
    const indexRecord: InstalledPluginIndexRecord = {
      pluginId: record.id,
      manifestPath: record.manifestPath,
      manifestHash,
      ...(doctorContractFile
        ? {
            doctorContractHash: doctorContractFile.hash,
            doctorContractFile: doctorContractFile.signature,
          }
        : {}),
      ...(manifestFile ? { manifestFile: manifestFile.signature } : {}),
      source: record.source,
      rootDir: record.rootDir,
      origin: record.origin,
      enabled,
      startup: buildStartupInfo(record),
      contributions: buildContributionInfo(record),
      compat: collectPluginManifestCompatCodes(record),
    };
    if (record.format && record.format !== "openclaw") {
      indexRecord.format = record.format;
    }
    if (record.bundleFormat) {
      indexRecord.bundleFormat = record.bundleFormat;
    }
    if (record.enabledByDefault === true) {
      indexRecord.enabledByDefault = true;
    }
    if (record.enabledByDefaultOnPlatforms?.length) {
      indexRecord.enabledByDefaultOnPlatforms = [...record.enabledByDefaultOnPlatforms];
    }
    if (record.syntheticAuthRefs?.length) {
      indexRecord.syntheticAuthRefs = [...record.syntheticAuthRefs];
    }
    if (record.setupSource) {
      indexRecord.setupSource = record.setupSource;
    }
    if (candidate?.packageName) {
      indexRecord.packageName = candidate.packageName;
    }
    if (candidate?.packageVersion) {
      indexRecord.packageVersion = candidate.packageVersion;
    }
    if (installRecord) {
      indexRecord.installRecordHash = hashJson(installRecord);
    }
    if (packageInstall) {
      indexRecord.packageInstall = packageInstall;
    }
    if (packageChannel) {
      indexRecord.packageChannel = packageChannel;
    }
    if (candidate?.packageManifest?.build) {
      indexRecord.packageBuild = structuredClone(candidate.packageManifest.build);
    }
    if (packageJson) {
      indexRecord.packageJson = packageJson;
    }
    return recordInstalledPluginIndexInstallOwner(
      indexRecord,
      installOwner,
      candidate ? isPluginCandidateInstallOwnerAmbiguous(candidate) : false,
    );
  });
}
