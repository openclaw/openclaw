import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
} from "../memory-host-sdk/dreaming.js";
import {
  resolveEffectiveEnableState,
  resolveEffectivePluginActivationState,
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
} from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { PluginCandidate, PluginDiscoveryResult } from "./discovery.js";
import { collectPluginManifestCompatCodes } from "./installed-plugin-index-record-builder.js";
import { buildProvenanceIndex, compareDuplicateCandidateOrder } from "./loader-provenance.js";
import { createPluginRecord, formatAutoEnabledActivationReason } from "./loader-records.js";
import type { PluginLoadOptions } from "./loader-types.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRecord } from "./registry.js";
import { hasKind } from "./slots.js";
import { encodeStartupTraceSegment } from "./startup-trace-segment.js";

export function detailPluginStartupTrace(
  startupTrace: PluginLoadOptions["startupTrace"] | undefined,
  pluginId: string,
  metrics: ReadonlyArray<readonly [string, number | string]>,
): void {
  startupTrace?.detail(
    `plugins.gateway-load.plugin.${encodeStartupTraceSegment(pluginId)}`,
    metrics,
  );
}

export type AuthorizedDreamingSidecar = {
  engineId: string;
  selectedMemoryPluginId: string;
};

function resolveDreamingSidecarEngineId(params: {
  cfg: OpenClawConfig;
  memorySlot: string | null | undefined;
}): string | null {
  const normalizedMemorySlot = normalizeLowercaseStringOrEmpty(params.memorySlot);
  if (
    !normalizedMemorySlot ||
    normalizedMemorySlot === "none" ||
    normalizedMemorySlot === DEFAULT_MEMORY_DREAMING_PLUGIN_ID
  ) {
    return null;
  }
  const dreamingConfig = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(params.cfg),
    cfg: params.cfg,
  });
  return dreamingConfig.enabled ? DEFAULT_MEMORY_DREAMING_PLUGIN_ID : null;
}

export function resolveAuthorizedDreamingSidecar(params: {
  cfg: OpenClawConfig;
  normalized: NormalizedPluginsConfig;
  activationSource: PluginActivationConfigSource;
  manifestRegistry: PluginManifestRegistry;
  memorySlot: string | null | undefined;
}): AuthorizedDreamingSidecar | null {
  const engineId = resolveDreamingSidecarEngineId({
    cfg: params.cfg,
    memorySlot: params.memorySlot,
  });
  if (!engineId || !params.normalized.enabled || !params.activationSource.plugins.enabled) {
    return null;
  }
  const selectedMemoryPluginId = normalizeLowercaseStringOrEmpty(params.memorySlot);
  if (!selectedMemoryPluginId || selectedMemoryPluginId === engineId) {
    return null;
  }
  if (
    params.normalized.deny.includes(engineId) ||
    params.activationSource.plugins.deny.includes(engineId) ||
    params.normalized.entries[engineId]?.enabled === false ||
    params.activationSource.plugins.entries[engineId]?.enabled === false
  ) {
    return null;
  }
  const selectedMemoryPlugin = params.manifestRegistry.plugins.find(
    (plugin) => plugin.id === selectedMemoryPluginId,
  );
  const sidecarPlugin = params.manifestRegistry.plugins.find((plugin) => plugin.id === engineId);
  if (
    !selectedMemoryPlugin ||
    !sidecarPlugin ||
    !hasKind(selectedMemoryPlugin.kind, "memory") ||
    !hasKind(sidecarPlugin.kind, "memory")
  ) {
    return null;
  }
  const selectedEnableState = resolveEffectiveEnableState({
    id: selectedMemoryPlugin.id,
    origin: selectedMemoryPlugin.origin,
    config: params.normalized,
    rootConfig: params.cfg,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(selectedMemoryPlugin),
    activationSource: params.activationSource,
  });
  return selectedEnableState.enabled ? { engineId, selectedMemoryPluginId } : null;
}

export function matchesScopedPluginOrDreamingSidecar(params: {
  onlyPluginIdSet: ReadonlySet<string> | null;
  pluginId: string;
  sidecar: AuthorizedDreamingSidecar | null;
}): boolean {
  if (!params.onlyPluginIdSet || params.onlyPluginIdSet.has(params.pluginId)) {
    return true;
  }
  return (
    params.pluginId === params.sidecar?.engineId &&
    params.onlyPluginIdSet.has(params.sidecar.selectedMemoryPluginId)
  );
}

export function resolvePluginCandidateActivation(params: {
  pluginId: string;
  candidate: PluginCandidate;
  manifestRecord: PluginManifestRecord;
  cfg: OpenClawConfig;
  normalized: NormalizedPluginsConfig;
  activationSource: PluginActivationConfigSource;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
  dreamingSidecar: AuthorizedDreamingSidecar | null;
}) {
  const isDreamingSidecar = params.dreamingSidecar?.engineId === params.pluginId;
  const activationState = isDreamingSidecar
    ? {
        enabled: true,
        activated: true,
        explicitlyEnabled: false,
        source: "auto" as const,
        reason: `dreaming sidecar for selected memory slot "${params.dreamingSidecar?.selectedMemoryPluginId ?? ""}"`,
      }
    : resolveEffectivePluginActivationState({
        id: params.pluginId,
        origin: params.candidate.origin,
        config: params.normalized,
        rootConfig: params.cfg,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(params.manifestRecord),
        activationSource: params.activationSource,
        autoEnabledReason: formatAutoEnabledActivationReason(
          params.autoEnabledReasons[params.pluginId],
        ),
      });
  const enableState = isDreamingSidecar
    ? { enabled: true, reason: undefined }
    : resolveEffectiveEnableState({
        id: params.pluginId,
        origin: params.candidate.origin,
        config: params.normalized,
        rootConfig: params.cfg,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(params.manifestRecord),
        activationSource: params.activationSource,
      });
  return { activationState, enableState, isDreamingSidecar };
}

export function createManifestPluginRecord(params: {
  candidate: PluginCandidate;
  manifestRecord: PluginManifestRecord;
  enabled: boolean;
  activationState: ReturnType<typeof resolveEffectivePluginActivationState>;
}): PluginRecord {
  const { candidate, manifestRecord } = params;
  return createPluginRecord({
    id: manifestRecord.id,
    name: manifestRecord.name ?? manifestRecord.id,
    description: manifestRecord.description,
    version: manifestRecord.version,
    packageName: manifestRecord.packageName,
    format: manifestRecord.format,
    bundleFormat: manifestRecord.bundleFormat,
    bundleCapabilities: manifestRecord.bundleCapabilities,
    source: candidate.source,
    rootDir: candidate.rootDir,
    origin: candidate.origin,
    workspaceDir: candidate.workspaceDir,
    trustedOfficialInstall: manifestRecord.trustedOfficialInstall,
    enabled: params.enabled,
    compat: collectPluginManifestCompatCodes(manifestRecord),
    activationState: params.activationState,
    syntheticAuthRefs: manifestRecord.syntheticAuthRefs,
    channelIds: manifestRecord.channels,
    providerIds: manifestRecord.providers,
    configSchema: Boolean(manifestRecord.configSchema),
    contracts: manifestRecord.contracts,
  });
}

export function applyPluginManifestRecordDetails(
  record: PluginRecord,
  manifestRecord: PluginManifestRecord,
): void {
  record.kind = manifestRecord.kind;
  record.configUiHints = manifestRecord.configUiHints;
  record.configJsonSchema = manifestRecord.configSchema;
}

export function createPluginCandidatesFromManifestRegistry(
  manifestRegistry: PluginManifestRegistry,
): PluginCandidate[] {
  return manifestRegistry.plugins.map((record) => ({
    idHint: record.id,
    rootDir: record.rootDir,
    source: record.source,
    ...(record.setupSource !== undefined ? { setupSource: record.setupSource } : {}),
    origin: record.origin,
    ...(record.workspaceDir !== undefined ? { workspaceDir: record.workspaceDir } : {}),
    ...(record.format !== undefined ? { format: record.format } : {}),
    ...(record.bundleFormat !== undefined ? { bundleFormat: record.bundleFormat } : {}),
    ...(record.packageManifest !== undefined ? { packageManifest: record.packageManifest } : {}),
  }));
}

export function preparePluginCandidates(params: {
  discovery: PluginDiscoveryResult;
  manifestRegistry: PluginManifestRegistry;
  normalizedLoadPaths: string[];
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}) {
  const provenance = buildProvenanceIndex({
    normalizedLoadPaths: params.normalizedLoadPaths,
    env: params.env,
    installRecords: params.installRecords,
  });
  const manifestByRoot = new Map(
    params.manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const orderedCandidates = [...params.discovery.candidates].toSorted((left, right) =>
    compareDuplicateCandidateOrder({
      left,
      right,
      manifestByRoot,
      provenance,
      env: params.env,
    }),
  );
  return { manifestByRoot, orderedCandidates, provenance };
}

export const defaultPluginLogger = () => createSubsystemLogger("plugins");

export function safeRealpathOrResolve(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
