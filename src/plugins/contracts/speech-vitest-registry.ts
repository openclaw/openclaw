import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  BUNDLED_IMAGE_GENERATION_PLUGIN_IDS,
  BUNDLED_MEDIA_UNDERSTANDING_PLUGIN_IDS,
  BUNDLED_REALTIME_TRANSCRIPTION_PLUGIN_IDS,
  BUNDLED_REALTIME_VOICE_PLUGIN_IDS,
  BUNDLED_SPEECH_PLUGIN_IDS,
  BUNDLED_VIDEO_GENERATION_PLUGIN_IDS,
} from "../bundled-capability-metadata.js";
import { loadBundledCapabilityRuntimeRegistry } from "../bundled-capability-runtime.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import { buildPluginLoaderAliasMap, buildPluginLoaderJitiOptions } from "../sdk-alias.js";
import type {
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  VideoGenerationProviderPlugin,
} from "../types.js";

export type SpeechProviderContractEntry = {
  pluginId: string;
  provider: SpeechProviderPlugin;
};

export type MediaUnderstandingProviderContractEntry = {
  pluginId: string;
  provider: MediaUnderstandingProviderPlugin;
};

export type RealtimeVoiceProviderContractEntry = {
  pluginId: string;
  provider: RealtimeVoiceProviderPlugin;
};

export type RealtimeTranscriptionProviderContractEntry = {
  pluginId: string;
  provider: RealtimeTranscriptionProviderPlugin;
};

export type ImageGenerationProviderContractEntry = {
  pluginId: string;
  provider: ImageGenerationProviderPlugin;
};

export type VideoGenerationProviderContractEntry = {
  pluginId: string;
  provider: VideoGenerationProviderPlugin;
};

function buildVitestCapabilityAliasMap(modulePath: string): Record<string, string> {
  const { ["openclaw/plugin-sdk"]: _ignoredRootAlias, ...scopedAliasMap } =
    buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url, "dist");
  return {
    ...scopedAliasMap,
    "openclaw/plugin-sdk/llm-task": fileURLToPath(
      new URL("../capability-runtime-vitest-shims/llm-task.ts", import.meta.url),
    ),
    "openclaw/plugin-sdk/media-runtime": fileURLToPath(
      new URL("../capability-runtime-vitest-shims/media-runtime.ts", import.meta.url),
    ),
    "openclaw/plugin-sdk/provider-onboard": fileURLToPath(
      new URL("../../plugin-sdk/provider-onboard.ts", import.meta.url),
    ),
    "openclaw/plugin-sdk/speech-core": fileURLToPath(
      new URL("../capability-runtime-vitest-shims/speech-core.ts", import.meta.url),
    ),
  };
}

function resolveNamedBuilder<T>(moduleExport: unknown, pattern: RegExp): (() => T) | undefined {
  if (!moduleExport || typeof moduleExport !== "object") {
    return undefined;
  }
  for (const [key, value] of Object.entries(moduleExport as Record<string, unknown>)) {
    if (pattern.test(key) && typeof value === "function") {
      return value as () => T;
    }
  }
  return undefined;
}

function resolveNamedValues<T>(
  moduleExport: unknown,
  pattern: RegExp,
  isMatch: (value: unknown) => value is T,
): T[] {
  if (!moduleExport || typeof moduleExport !== "object") {
    return [];
  }
  const matches: T[] = [];
  for (const [key, value] of Object.entries(moduleExport as Record<string, unknown>)) {
    if (pattern.test(key) && isMatch(value)) {
      matches.push(value);
    }
  }
  return matches;
}

function resolveTestApiModuleRecords(pluginIds: readonly string[]) {
  const unresolvedPluginIds = new Set(pluginIds);
  const manifests = loadPluginManifestRegistry({}).plugins.filter(
    (plugin) => plugin.origin === "bundled" && unresolvedPluginIds.has(plugin.id),
  );
  return { manifests, unresolvedPluginIds };
}

function createVitestCapabilityLoader(modulePath: string) {
  return createJiti(import.meta.url, {
    ...buildPluginLoaderJitiOptions(buildVitestCapabilityAliasMap(modulePath)),
    tryNative: false,
  });
}

function isMediaUnderstandingProvider(value: unknown): value is MediaUnderstandingProviderPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { describeImage?: unknown }).describeImage === "function"
  );
}

export function loadVitestSpeechProviderContractRegistry(): SpeechProviderContractEntry[] {
  const registrations: SpeechProviderContractEntry[] = [];
  const { manifests, unresolvedPluginIds } = resolveTestApiModuleRecords(BUNDLED_SPEECH_PLUGIN_IDS);

  for (const plugin of manifests) {
    if (!plugin.rootDir) {
      continue;
    }
    const testApiPath = path.join(plugin.rootDir, "test-api.ts");
    if (!fs.existsSync(testApiPath)) {
      continue;
    }
    const builder = resolveNamedBuilder<SpeechProviderPlugin>(
      createVitestCapabilityLoader(testApiPath)(testApiPath),
      /^build.+SpeechProvider$/u,
    );
    if (!builder) {
      continue;
    }
    registrations.push({
      pluginId: plugin.id,
      provider: builder(),
    });
    unresolvedPluginIds.delete(plugin.id);
  }

  if (unresolvedPluginIds.size === 0) {
    return registrations;
  }

  const runtimeRegistry = loadBundledCapabilityRuntimeRegistry({
    pluginIds: [...unresolvedPluginIds],
    pluginSdkResolution: "dist",
  });
  registrations.push(
    ...runtimeRegistry.speechProviders.map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
    })),
  );
  return registrations;
}

export function loadVitestMediaUnderstandingProviderContractRegistry(): MediaUnderstandingProviderContractEntry[] {
  const registrations: MediaUnderstandingProviderContractEntry[] = [];
  const { manifests, unresolvedPluginIds } = resolveTestApiModuleRecords(
    BUNDLED_MEDIA_UNDERSTANDING_PLUGIN_IDS,
  );

  for (const plugin of manifests) {
    if (!plugin.rootDir) {
      continue;
    }
    const testApiPath = path.join(plugin.rootDir, "test-api.ts");
    if (!fs.existsSync(testApiPath)) {
      continue;
    }
    const providers = resolveNamedValues<MediaUnderstandingProviderPlugin>(
      createVitestCapabilityLoader(testApiPath)(testApiPath),
      /MediaUnderstandingProvider$/u,
      isMediaUnderstandingProvider,
    );
    if (providers.length === 0) {
      continue;
    }
    registrations.push(...providers.map((provider) => ({ pluginId: plugin.id, provider })));
    unresolvedPluginIds.delete(plugin.id);
  }

  if (unresolvedPluginIds.size === 0) {
    return registrations;
  }

  const runtimeRegistry = loadBundledCapabilityRuntimeRegistry({
    pluginIds: [...unresolvedPluginIds],
    pluginSdkResolution: "dist",
  });
  registrations.push(
    ...runtimeRegistry.mediaUnderstandingProviders.map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
    })),
  );
  return registrations;
}

export function loadVitestRealtimeVoiceProviderContractRegistry(): RealtimeVoiceProviderContractEntry[] {
  const registrations: RealtimeVoiceProviderContractEntry[] = [];
  const { manifests, unresolvedPluginIds } = resolveTestApiModuleRecords(
    BUNDLED_REALTIME_VOICE_PLUGIN_IDS,
  );

  for (const plugin of manifests) {
    if (!plugin.rootDir) {
      continue;
    }
    const testApiPath = path.join(plugin.rootDir, "test-api.ts");
    if (!fs.existsSync(testApiPath)) {
      continue;
    }
    const builder = resolveNamedBuilder<RealtimeVoiceProviderPlugin>(
      createVitestCapabilityLoader(testApiPath)(testApiPath),
      /^build.+RealtimeVoiceProvider$/u,
    );
    if (!builder) {
      continue;
    }
    registrations.push({
      pluginId: plugin.id,
      provider: builder(),
    });
    unresolvedPluginIds.delete(plugin.id);
  }

  if (unresolvedPluginIds.size === 0) {
    return registrations;
  }

  const runtimeRegistry = loadBundledCapabilityRuntimeRegistry({
    pluginIds: [...unresolvedPluginIds],
    pluginSdkResolution: "dist",
  });
  registrations.push(
    ...runtimeRegistry.realtimeVoiceProviders.map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
    })),
  );
  return registrations;
}

export function loadVitestRealtimeTranscriptionProviderContractRegistry(): RealtimeTranscriptionProviderContractEntry[] {
  const registrations: RealtimeTranscriptionProviderContractEntry[] = [];
  const { manifests, unresolvedPluginIds } = resolveTestApiModuleRecords(
    BUNDLED_REALTIME_TRANSCRIPTION_PLUGIN_IDS,
  );

  for (const plugin of manifests) {
    if (!plugin.rootDir) {
      continue;
    }
    const testApiPath = path.join(plugin.rootDir, "test-api.ts");
    if (!fs.existsSync(testApiPath)) {
      continue;
    }
    const builder = resolveNamedBuilder<RealtimeTranscriptionProviderPlugin>(
      createVitestCapabilityLoader(testApiPath)(testApiPath),
      /^build.+RealtimeTranscriptionProvider$/u,
    );
    if (!builder) {
      continue;
    }
    registrations.push({
      pluginId: plugin.id,
      provider: builder(),
    });
    unresolvedPluginIds.delete(plugin.id);
  }

  if (unresolvedPluginIds.size === 0) {
    return registrations;
  }

  const runtimeRegistry = loadBundledCapabilityRuntimeRegistry({
    pluginIds: [...unresolvedPluginIds],
    pluginSdkResolution: "dist",
  });
  registrations.push(
    ...runtimeRegistry.realtimeTranscriptionProviders.map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
    })),
  );
  return registrations;
}

export function loadVitestImageGenerationProviderContractRegistry(): ImageGenerationProviderContractEntry[] {
  const registrations: ImageGenerationProviderContractEntry[] = [];
  const { manifests, unresolvedPluginIds } = resolveTestApiModuleRecords(
    BUNDLED_IMAGE_GENERATION_PLUGIN_IDS,
  );

  for (const plugin of manifests) {
    if (!plugin.rootDir) {
      continue;
    }
    const testApiPath = path.join(plugin.rootDir, "test-api.ts");
    if (!fs.existsSync(testApiPath)) {
      continue;
    }
    const builder = resolveNamedBuilder<ImageGenerationProviderPlugin>(
      createVitestCapabilityLoader(testApiPath)(testApiPath),
      /^build.+ImageGenerationProvider$/u,
    );
    if (!builder) {
      continue;
    }
    registrations.push({
      pluginId: plugin.id,
      provider: builder(),
    });
    unresolvedPluginIds.delete(plugin.id);
  }

  if (unresolvedPluginIds.size === 0) {
    return registrations;
  }

  const runtimeRegistry = loadBundledCapabilityRuntimeRegistry({
    pluginIds: [...unresolvedPluginIds],
    pluginSdkResolution: "dist",
  });
  registrations.push(
    ...runtimeRegistry.imageGenerationProviders.map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
    })),
  );
  return registrations;
}

export function loadVitestVideoGenerationProviderContractRegistry(): VideoGenerationProviderContractEntry[] {
  const registrations: VideoGenerationProviderContractEntry[] = [];
  const { manifests, unresolvedPluginIds } = resolveTestApiModuleRecords(
    BUNDLED_VIDEO_GENERATION_PLUGIN_IDS,
  );

  for (const plugin of manifests) {
    if (!plugin.rootDir) {
      continue;
    }
    const testApiPath = path.join(plugin.rootDir, "test-api.ts");
    if (!fs.existsSync(testApiPath)) {
      continue;
    }
    const builder = resolveNamedBuilder<VideoGenerationProviderPlugin>(
      createVitestCapabilityLoader(testApiPath)(testApiPath),
      /^build.+VideoGenerationProvider$/u,
    );
    if (!builder) {
      continue;
    }
    registrations.push({
      pluginId: plugin.id,
      provider: builder(),
    });
    unresolvedPluginIds.delete(plugin.id);
  }

  if (unresolvedPluginIds.size === 0) {
    return registrations;
  }

  const runtimeRegistry = loadBundledCapabilityRuntimeRegistry({
    pluginIds: [...unresolvedPluginIds],
    pluginSdkResolution: "dist",
  });
  registrations.push(
    ...runtimeRegistry.videoGenerationProviders.map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
    })),
  );
  return registrations;
}
