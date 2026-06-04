import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveBundledPluginRepoEntryPath } from "./bundled-plugin-metadata.js";
import { createCapturedPluginRegistration } from "./captured-registration.js";
import { resolveOpenClawDevSourceRoot } from "./dev-source-root.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
  type PluginModuleLoaderCache,
} from "./plugin-module-loader-cache.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import {
  buildPluginLoaderAliasMap,
  shouldPreferNativeModuleLoad,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";
import {
  findUndeclaredPluginToolNames,
  normalizePluginToolContractNames,
} from "./tool-contracts.js";
import type { OpenClawPluginDefinition, OpenClawPluginModule } from "./types.js";

const log = createSubsystemLogger("plugins");

const CAPABILITY_VITEST_SHIM_ALIASES = [
  {
    subpath: "config-runtime",
    target: new URL("./capability-runtime-vitest-shims/config-runtime.ts", import.meta.url),
  },
  {
    subpath: "media-runtime",
    target: new URL("./capability-runtime-vitest-shims/media-runtime.ts", import.meta.url),
  },
  {
    subpath: "provider-onboard",
    target: new URL("../plugin-sdk/provider-onboard.ts", import.meta.url),
  },
  {
    subpath: "speech-core",
    target: new URL("./capability-runtime-vitest-shims/speech-core.ts", import.meta.url),
  },
] as const;

export function buildVitestCapabilityShimAliasMap(): Record<string, string> {
  return Object.fromEntries(
    CAPABILITY_VITEST_SHIM_ALIASES.flatMap(({ subpath, target }) => {
      const targetPath = fileURLToPath(target);
      return [
        [`openclaw/plugin-sdk/${subpath}`, targetPath],
        [`@openclaw/plugin-sdk/${subpath}`, targetPath],
      ];
    }),
  );
}

function applyVitestCapabilityAliasOverrides(params: {
  aliasMap: Record<string, string>;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  env?: PluginLoadOptions["env"];
}): Record<string, string> {
  if (!params.env?.VITEST || params.pluginSdkResolution !== "dist") {
    return params.aliasMap;
  }

  const {
    "openclaw/plugin-sdk": _ignoredLegacyRootAlias,
    "@openclaw/plugin-sdk": _ignoredScopedRootAlias,
    ...scopedAliasMap
  } = params.aliasMap;
  return {
    ...scopedAliasMap,
    // Capability contract loads only need a narrow SDK slice. Keep those
    // helpers on a tiny source graph so Vitest does not pull the dist chunk
    // bundle that also drags Matrix/WhatsApp code into these tests.
    ...buildVitestCapabilityShimAliasMap(),
  };
}

function shouldApplyVitestCapabilityAliasOverrides(params: {
  pluginSdkResolution?: PluginSdkResolutionPreference;
  env?: PluginLoadOptions["env"];
}): boolean {
  return Boolean(params.env?.VITEST && params.pluginSdkResolution === "dist");
}

export function buildBundledCapabilityRuntimeConfig(
  pluginIds: readonly string[],
  env?: PluginLoadOptions["env"],
): PluginLoadOptions["config"] {
  const enablementCompat = withBundledPluginEnablementCompat({
    config: undefined,
    pluginIds,
  });
  return withBundledPluginVitestCompat({
    config: enablementCompat,
    pluginIds,
    env,
  });
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (typeof resolved === "function") {
    return {
      register: resolved as OpenClawPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const definition = resolved as OpenClawPluginDefinition;
    return {
      definition,
      register: definition.register ?? definition.activate,
    };
  }
  return {};
}

function createCapabilityPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  source: string;
  rootDir?: string;
  workspaceDir?: string;
  contracts?: PluginRecord["contracts"];
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    version: params.version,
    description: params.description,
    source: params.source,
    rootDir: params.rootDir,
    origin: "bundled",
    workspaceDir: params.workspaceDir,
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    embeddingProviderIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    transcriptSourceProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: true,
    contracts: params.contracts,
  };
}

function recordCapabilityLoadError(
  registry: PluginRegistry,
  record: PluginRecord,
  message: string,
): void {
  record.status = "error";
  record.error = message;
  registry.plugins.push(record);
  registry.diagnostics.push({
    level: "error",
    pluginId: record.id,
    source: record.source,
    message: `failed to load plugin: ${message}`,
  });
  log.error(`[plugins] ${record.id} failed to load from ${record.source}: ${message}`);
}

function recordCapabilityRegistrationError(
  registry: PluginRegistry,
  record: PluginRecord,
  message: string,
): void {
  registry.diagnostics.push({
    level: "error",
    pluginId: record.id,
    source: record.source,
    message,
  });
}

function formatCapabilityFieldError(params: {
  capability: string;
  field: string;
  error?: unknown;
}): string {
  const detail =
    params.error instanceof Error
      ? params.error.message
      : params.error === undefined
        ? undefined
        : String(params.error);
  return detail
    ? `plugin ${params.capability} registration missing readable ${params.field}: ${detail}`
    : `plugin ${params.capability} registration missing readable ${params.field}`;
}

function snapshotCapturedStringField<TEntry>(
  registry: PluginRegistry,
  record: PluginRecord,
  capability: string,
  field: string,
  entries: readonly TEntry[],
): Array<{ entry: TEntry; value: string }> {
  const snapshots: Array<{ entry: TEntry; value: string }> = [];
  for (const entry of entries) {
    let value: unknown;
    try {
      value = (entry as Record<string, unknown>)[field];
    } catch (error) {
      recordCapabilityRegistrationError(
        registry,
        record,
        formatCapabilityFieldError({ capability, field, error }),
      );
      continue;
    }
    if (typeof value !== "string") {
      recordCapabilityRegistrationError(
        registry,
        record,
        formatCapabilityFieldError({ capability, field }),
      );
      continue;
    }
    snapshots.push({ entry, value });
  }
  return snapshots;
}

export function loadBundledCapabilityRuntimeRegistry(params: {
  pluginIds: readonly string[];
  env?: PluginLoadOptions["env"];
  pluginSdkResolution?: PluginSdkResolutionPreference;
  discovery?: PluginDiscoveryResult;
}) {
  const env = params.env ?? process.env;
  const devSourceRoot = resolveOpenClawDevSourceRoot(env);
  const pluginIds = new Set(params.pluginIds);
  const registry = createEmptyPluginRegistry();
  const moduleLoaders: PluginModuleLoaderCache = createPluginModuleLoaderCache();

  const getModuleLoader = (modulePath: string) => {
    const tryNative =
      shouldPreferNativeModuleLoad(modulePath) &&
      !(env?.VITEST && params.pluginSdkResolution === "dist");
    const aliasMap = shouldApplyVitestCapabilityAliasOverrides({
      pluginSdkResolution: params.pluginSdkResolution,
      env,
    })
      ? applyVitestCapabilityAliasOverrides({
          aliasMap: buildPluginLoaderAliasMap(
            modulePath,
            process.argv[1],
            import.meta.url,
            params.pluginSdkResolution,
            devSourceRoot,
          ),
          pluginSdkResolution: params.pluginSdkResolution,
          env,
        })
      : undefined;
    return getCachedPluginModuleLoader({
      cache: moduleLoaders,
      modulePath,
      importerUrl: import.meta.url,
      devSourceRoot,
      loaderFilename: import.meta.url,
      ...(aliasMap ? { aliasMap } : {}),
      pluginSdkResolution: params.pluginSdkResolution,
      tryNative,
    });
  };

  const discovery = params.discovery ?? discoverOpenClawPlugins({ env });
  const manifestRegistry = loadPluginManifestRegistry({
    config: buildBundledCapabilityRuntimeConfig(params.pluginIds, env),
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  registry.diagnostics.push(...manifestRegistry.diagnostics);

  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const seenPluginIds = new Set<string>();
  const repoRoot = process.cwd();

  for (const candidate of discovery.candidates) {
    const manifest = manifestByRoot.get(candidate.rootDir);
    if (!manifest || manifest.origin !== "bundled" || !pluginIds.has(manifest.id)) {
      continue;
    }
    if (seenPluginIds.has(manifest.id)) {
      continue;
    }
    seenPluginIds.add(manifest.id);

    const record = createCapabilityPluginRecord({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      contracts: manifest.contracts,
      source:
        env?.VITEST && params.pluginSdkResolution === "dist"
          ? (resolveBundledPluginRepoEntryPath({
              rootDir: repoRoot,
              pluginId: manifest.id,
              preferBuilt: true,
            }) ?? candidate.source)
          : candidate.source,
      rootDir: candidate.rootDir,
      workspaceDir: candidate.workspaceDir,
    });

    const opened = openRootFileSync({
      absolutePath: record.source,
      rootPath: record.source === candidate.source ? candidate.rootDir : repoRoot,
      boundaryLabel: record.source === candidate.source ? "plugin root" : "repo root",
      rejectHardlinks: false,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      recordCapabilityLoadError(
        registry,
        record,
        "plugin entry path escapes plugin root or fails alias checks",
      );
      continue;
    }

    const safeSource = opened.path;
    fs.closeSync(opened.fd);

    let mod: OpenClawPluginModule | null;
    try {
      mod = getModuleLoader(safeSource)(safeSource) as OpenClawPluginModule;
    } catch (error) {
      recordCapabilityLoadError(registry, record, String(error));
      continue;
    }

    const resolved = resolvePluginModuleExport(mod);
    const register = resolved.register;
    if (typeof register !== "function") {
      record.status = "disabled";
      record.error = "plugin export missing register(api)";
      registry.plugins.push(record);
      continue;
    }

    try {
      const captured = createCapturedPluginRegistration();
      register(captured.api);
      const snapshot = <TEntry>(capability: string, field: string, entries: readonly TEntry[]) =>
        snapshotCapturedStringField(registry, record, capability, field, entries);
      const capturedCliBackends = snapshot("CLI backend", "id", captured.cliBackends);
      const capturedProviders = snapshot("provider", "id", captured.providers);
      const capturedEmbeddingProviders = snapshot(
        "embedding provider",
        "id",
        captured.embeddingProviders,
      );
      const capturedSpeechProviders = snapshot("speech provider", "id", captured.speechProviders);
      const capturedRealtimeTranscriptionProviders = snapshot(
        "realtime transcription provider",
        "id",
        captured.realtimeTranscriptionProviders,
      );
      const capturedRealtimeVoiceProviders = snapshot(
        "realtime voice provider",
        "id",
        captured.realtimeVoiceProviders,
      );
      const capturedMediaUnderstandingProviders = snapshot(
        "media understanding provider",
        "id",
        captured.mediaUnderstandingProviders,
      );
      const capturedTranscriptSourceProviders = snapshot(
        "transcript source provider",
        "id",
        captured.transcriptSourceProviders,
      );
      const capturedImageGenerationProviders = snapshot(
        "image generation provider",
        "id",
        captured.imageGenerationProviders,
      );
      const capturedVideoGenerationProviders = snapshot(
        "video generation provider",
        "id",
        captured.videoGenerationProviders,
      );
      const capturedMusicGenerationProviders = snapshot(
        "music generation provider",
        "id",
        captured.musicGenerationProviders,
      );
      const capturedWebFetchProviders = snapshot(
        "web fetch provider",
        "id",
        captured.webFetchProviders,
      );
      const capturedWebSearchProviders = snapshot(
        "web search provider",
        "id",
        captured.webSearchProviders,
      );
      const capturedMigrationProviders = snapshot(
        "migration provider",
        "id",
        captured.migrationProviders,
      );
      const capturedMemoryEmbeddingProviders = snapshot(
        "memory embedding provider",
        "id",
        captured.memoryEmbeddingProviders,
      );
      const capturedAgentHarnesses = snapshot("agent harness", "id", captured.agentHarnesses);
      const capturedTools = snapshot("tool", "name", captured.tools);

      record.cliBackendIds.push(...capturedCliBackends.map((entry) => entry.value));
      record.providerIds.push(...capturedProviders.map((entry) => entry.value));
      record.embeddingProviderIds.push(...capturedEmbeddingProviders.map((entry) => entry.value));
      record.speechProviderIds.push(...capturedSpeechProviders.map((entry) => entry.value));
      record.realtimeTranscriptionProviderIds.push(
        ...capturedRealtimeTranscriptionProviders.map((entry) => entry.value),
      );
      record.realtimeVoiceProviderIds.push(
        ...capturedRealtimeVoiceProviders.map((entry) => entry.value),
      );
      record.mediaUnderstandingProviderIds.push(
        ...capturedMediaUnderstandingProviders.map((entry) => entry.value),
      );
      record.transcriptSourceProviderIds.push(
        ...capturedTranscriptSourceProviders.map((entry) => entry.value),
      );
      record.imageGenerationProviderIds.push(
        ...capturedImageGenerationProviders.map((entry) => entry.value),
      );
      record.videoGenerationProviderIds.push(
        ...capturedVideoGenerationProviders.map((entry) => entry.value),
      );
      record.musicGenerationProviderIds.push(
        ...capturedMusicGenerationProviders.map((entry) => entry.value),
      );
      record.webFetchProviderIds.push(...capturedWebFetchProviders.map((entry) => entry.value));
      record.webSearchProviderIds.push(...capturedWebSearchProviders.map((entry) => entry.value));
      record.migrationProviderIds.push(...capturedMigrationProviders.map((entry) => entry.value));
      record.memoryEmbeddingProviderIds.push(
        ...capturedMemoryEmbeddingProviders.map((entry) => entry.value),
      );
      record.agentHarnessIds.push(...capturedAgentHarnesses.map((entry) => entry.value));
      record.toolNames.push(...capturedTools.map((entry) => entry.value));

      registry.cliBackends?.push(
        ...capturedCliBackends.map(({ entry: backend }) => ({
          pluginId: record.id,
          pluginName: record.name,
          backend,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.textTransforms.push(
        ...captured.textTransforms.map((transforms) => ({
          pluginId: record.id,
          pluginName: record.name,
          transforms,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.providers.push(
        ...capturedProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.embeddingProviders.push(
        ...capturedEmbeddingProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.speechProviders.push(
        ...capturedSpeechProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.realtimeTranscriptionProviders.push(
        ...capturedRealtimeTranscriptionProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.realtimeVoiceProviders.push(
        ...capturedRealtimeVoiceProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.mediaUnderstandingProviders.push(
        ...capturedMediaUnderstandingProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.transcriptSourceProviders.push(
        ...capturedTranscriptSourceProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.imageGenerationProviders.push(
        ...capturedImageGenerationProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.videoGenerationProviders.push(
        ...capturedVideoGenerationProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.musicGenerationProviders.push(
        ...capturedMusicGenerationProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.webFetchProviders.push(
        ...capturedWebFetchProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.webSearchProviders.push(
        ...capturedWebSearchProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.migrationProviders.push(
        ...capturedMigrationProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.memoryEmbeddingProviders.push(
        ...capturedMemoryEmbeddingProviders.map(({ entry: provider }) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      registry.agentHarnesses.push(
        ...capturedAgentHarnesses.map(({ entry: harness }) => ({
          pluginId: record.id,
          pluginName: record.name,
          harness,
          source: record.source,
          rootDir: record.rootDir,
        })),
      );
      const declaredToolNames = normalizePluginToolContractNames(record.contracts);
      for (const { entry: tool, value: toolName } of capturedTools) {
        const undeclared = findUndeclaredPluginToolNames({
          declaredNames: declaredToolNames,
          toolNames: [toolName],
        });
        if (undeclared.length > 0) {
          registry.diagnostics.push({
            level: "error",
            pluginId: record.id,
            source: record.source,
            message: `plugin must declare contracts.tools for: ${undeclared.join(", ")}`,
          });
          continue;
        }
        registry.tools.push({
          pluginId: record.id,
          pluginName: record.name,
          factory: () => tool,
          names: [toolName],
          declaredNames: declaredToolNames,
          optional: false,
          source: record.source,
          rootDir: record.rootDir,
        });
      }
      registry.plugins.push(record);
    } catch (error) {
      recordCapabilityLoadError(registry, record, String(error));
    }
  }

  return registry;
}
