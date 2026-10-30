// Bundled capability metadata inventory lists capability metadata used by plugin contracts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tryReadJsonSync } from "../../../infra/json-files.js";
import {
  normalizeBundledPluginStringList,
  resolveBundledPluginScanDir,
} from "../../bundled-plugin-scan.js";
import {
  getPackageManifestMetadata,
  PLUGIN_MANIFEST_FILENAME,
  type PackageManifest,
  type PluginManifest,
} from "../../manifest.js";
import { resolveLoaderPackageRoot } from "../../sdk-alias.js";
import { normalizeContractStringValues } from "../shared.js";

// Build/test inventory only.
// Runtime code should prefer manifest/runtime registry queries instead of these snapshots.

export type BundledPluginContractSnapshot = {
  pluginId: string;
  cliBackendIds: string[];
  providerIds: string[];
  providerEnvVars: Record<string, string[]>;
  workerProviderIds: string[];
  storageProviderIds: string[];
  embeddingProviderIds: string[];
  speechProviderIds: string[];
  realtimeTranscriptionProviderIds: string[];
  realtimeVoiceProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  transcriptSourceProviderIds: string[];
  documentExtractorIds: string[];
  imageGenerationProviderIds: string[];
  videoGenerationProviderIds: string[];
  musicGenerationProviderIds: string[];
  webContentExtractorIds: string[];
  webFetchProviderIds: string[];
  webSearchProviderIds: string[];
  migrationProviderIds: string[];
  toolNames: string[];
};

const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: CURRENT_MODULE_PATH,
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../../../..", import.meta.url));
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type BundledCapabilityManifest = Pick<
  PluginManifest,
  | "id"
  | "autoEnableWhenConfiguredProviders"
  | "cliBackends"
  | "contracts"
  | "legacyPluginIds"
  | "providers"
  | "setup"
>;

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  const raw = tryReadJsonSync(filePath);
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function readBundledCapabilityManifest(pluginDir: string): BundledCapabilityManifest | undefined {
  const packageJson = readJsonRecord(path.join(pluginDir, "package.json"));
  const packageManifest = getPackageManifestMetadata(packageJson as PackageManifest);
  const extensions = normalizeBundledPluginStringList(packageManifest?.extensions);
  if (extensions.length === 0) {
    return undefined;
  }

  const raw = readJsonRecord(path.join(pluginDir, PLUGIN_MANIFEST_FILENAME));
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  if (!id) {
    return undefined;
  }
  return raw as BundledCapabilityManifest;
}

function listBundledCapabilityManifests(): readonly BundledCapabilityManifest[] {
  const scanDir = resolveBundledPluginScanDir({
    packageRoot: OPENCLAW_PACKAGE_ROOT,
    runningFromBuiltArtifact: RUNNING_FROM_BUILT_ARTIFACT,
  });
  if (!scanDir) {
    return [];
  }
  return fs
    .readdirSync(scanDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readBundledCapabilityManifest(path.join(scanDir, entry.name)))
    .filter((manifest): manifest is BundledCapabilityManifest => manifest !== undefined)
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

const BUNDLED_CAPABILITY_MANIFESTS = listBundledCapabilityManifests();

function normalizeSetupProviderEnvVars(setup: PluginManifest["setup"]): Record<string, string[]> {
  return Object.fromEntries(
    (setup?.providers ?? [])
      .map(
        (provider) =>
          [
            provider.id.trim(),
            normalizeContractStringValues(provider.envVars ?? [], (value) =>
              typeof value === "string" ? value.trim() : "",
            ),
          ] as const,
      )
      .filter(([key, values]) => key && values.length > 0)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function buildBundledPluginContractSnapshot(
  manifest: BundledCapabilityManifest,
): BundledPluginContractSnapshot {
  const ids = (values: readonly string[] | undefined) =>
    normalizeContractStringValues(values, (value) => value.trim());
  const contracts = manifest.contracts;
  return {
    pluginId: manifest.id,
    cliBackendIds: ids(manifest.cliBackends),
    providerIds: ids(manifest.providers),
    providerEnvVars: normalizeSetupProviderEnvVars(manifest.setup),
    workerProviderIds: ids(contracts?.workerProviders),
    storageProviderIds: ids(contracts?.storageProviders),
    embeddingProviderIds: ids(contracts?.embeddingProviders),
    speechProviderIds: ids(contracts?.speechProviders),
    realtimeTranscriptionProviderIds: ids(contracts?.realtimeTranscriptionProviders),
    realtimeVoiceProviderIds: ids(contracts?.realtimeVoiceProviders),
    mediaUnderstandingProviderIds: ids(contracts?.mediaUnderstandingProviders),
    transcriptSourceProviderIds: ids(contracts?.transcriptSourceProviders),
    documentExtractorIds: ids(contracts?.documentExtractors),
    imageGenerationProviderIds: ids(contracts?.imageGenerationProviders),
    videoGenerationProviderIds: ids(contracts?.videoGenerationProviders),
    musicGenerationProviderIds: ids(contracts?.musicGenerationProviders),
    webContentExtractorIds: ids(contracts?.webContentExtractors),
    webFetchProviderIds: ids(contracts?.webFetchProviders),
    webSearchProviderIds: ids(contracts?.webSearchProviders),
    migrationProviderIds: ids(contracts?.migrationProviders),
    toolNames: ids(contracts?.tools),
  };
}

function hasBundledPluginContractSnapshotCapabilities(
  entry: BundledPluginContractSnapshot,
): boolean {
  return Object.values(entry).some((value) => Array.isArray(value) && value.length > 0);
}

export const BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS: readonly BundledPluginContractSnapshot[] =
  BUNDLED_CAPABILITY_MANIFESTS.map(buildBundledPluginContractSnapshot)
    .filter(hasBundledPluginContractSnapshotCapabilities)
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
