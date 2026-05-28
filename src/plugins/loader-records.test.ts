import { describe, expect, it, vi } from "vitest";
import { createPluginRecord, recordPluginError } from "./loader-records.js";
import { createEmptyPluginRegistry } from "./registry.js";

describe("plugin loader records", () => {
  it("preserves manifest-declared channel ids before runtime registration", () => {
    const record = createPluginRecord({
      id: "kitchen-sink",
      name: "Kitchen Sink",
      source: "/tmp/kitchen-sink/index.js",
      origin: "global",
      enabled: true,
      channelIds: ["kitchen-sink-channel"],
      configSchema: false,
    });

    expect(record.channelIds).toEqual(["kitchen-sink-channel"]);
  });

  it("preserves manifest-declared provider ids before runtime registration", () => {
    const record = createPluginRecord({
      id: "kitchen-sink",
      name: "Kitchen Sink",
      source: "/tmp/kitchen-sink/index.js",
      origin: "global",
      enabled: true,
      providerIds: ["kitchen-sink-provider"],
      configSchema: false,
    });

    expect(record.providerIds).toEqual(["kitchen-sink-provider"]);
  });

  it("initializes circuit breaker state from manifest criticality", () => {
    const record = createPluginRecord({
      id: "experimental-plugin",
      source: "/tmp/experimental-plugin/index.js",
      origin: "workspace",
      enabled: true,
      criticality: "experimental",
      configSchema: true,
    });

    expect(record.criticality).toBe("experimental");
    expect(record.circuitBreaker).toMatchObject({
      pluginId: "experimental-plugin",
      criticality: "experimental",
      status: "closed",
      consecutiveFailures: 0,
    });
  });

  it("records loader failures into plugin circuit breaker state", () => {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({
      id: "unstable-plugin",
      source: "/tmp/unstable-plugin/index.js",
      origin: "workspace",
      enabled: true,
      criticality: "experimental",
      configSchema: true,
    });

    recordPluginError({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      registry,
      record,
      seenIds: new Map(),
      pluginId: record.id,
      origin: record.origin,
      phase: "load",
      error: new Error("boom"),
      logPrefix: "[plugins] unstable-plugin failed to load: ",
      diagnosticMessagePrefix: "failed to load plugin: ",
    });

    expect(registry.plugins[0]?.circuitBreaker).toMatchObject({
      pluginId: "unstable-plugin",
      criticality: "experimental",
      status: "open",
      consecutiveFailures: 1,
      lastFailureReason: "load_error",
    });
  });

  it("preserves manifest-declared capability provider ids before runtime registration", () => {
    const record = createPluginRecord({
      id: "kitchen-sink",
      name: "Kitchen Sink",
      source: "/tmp/kitchen-sink/index.js",
      origin: "global",
      enabled: true,
      contracts: {
        speechProviders: ["kitchen-sink-speech-provider"],
        realtimeTranscriptionProviders: ["kitchen-sink-transcription-provider"],
        realtimeVoiceProviders: ["kitchen-sink-voice-provider"],
        mediaUnderstandingProviders: ["kitchen-sink-media-provider"],
        imageGenerationProviders: ["kitchen-sink-image-provider"],
        videoGenerationProviders: ["kitchen-sink-video-provider"],
        musicGenerationProviders: ["kitchen-sink-music-provider"],
        webFetchProviders: ["kitchen-sink-web-fetch-provider"],
        webSearchProviders: ["kitchen-sink-web-search-provider"],
        migrationProviders: ["kitchen-sink-migration-provider"],
        memoryEmbeddingProviders: ["kitchen-sink-memory-provider"],
      },
      configSchema: false,
    });

    expect(record.speechProviderIds).toEqual(["kitchen-sink-speech-provider"]);
    expect(record.realtimeTranscriptionProviderIds).toEqual([
      "kitchen-sink-transcription-provider",
    ]);
    expect(record.realtimeVoiceProviderIds).toEqual(["kitchen-sink-voice-provider"]);
    expect(record.mediaUnderstandingProviderIds).toEqual(["kitchen-sink-media-provider"]);
    expect(record.imageGenerationProviderIds).toEqual(["kitchen-sink-image-provider"]);
    expect(record.videoGenerationProviderIds).toEqual(["kitchen-sink-video-provider"]);
    expect(record.musicGenerationProviderIds).toEqual(["kitchen-sink-music-provider"]);
    expect(record.webFetchProviderIds).toEqual(["kitchen-sink-web-fetch-provider"]);
    expect(record.webSearchProviderIds).toEqual(["kitchen-sink-web-search-provider"]);
    expect(record.migrationProviderIds).toEqual(["kitchen-sink-migration-provider"]);
    expect(record.memoryEmbeddingProviderIds).toEqual(["kitchen-sink-memory-provider"]);
  });
});
