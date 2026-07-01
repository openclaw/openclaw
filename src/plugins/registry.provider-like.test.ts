/** Verifies provider-like plugin registry entries across capability families. */
import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

function createCatalogModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
  };
}

describe("plugin registry provider-like registrations", () => {
  it("captures unified model catalog provider registrations", () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "catalog-owner",
      name: "Catalog Owner",
      source: "/tmp/catalog-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerModelCatalogProvider(record, {
      provider: "catalog-provider",
      kinds: ["text", "video_generation"],
      staticCatalog: () => [
        {
          kind: "text",
          provider: "catalog-provider",
          model: "catalog-model",
          source: "static",
        },
      ],
    });

    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogRegistration = pluginRegistry.registry.modelCatalogProviders[0];
    expect(catalogRegistration?.pluginId).toBe("catalog-owner");
    expect(catalogRegistration?.provider.provider).toBe("catalog-provider");
    expect(catalogRegistration?.provider.kinds).toEqual(["text", "video_generation"]);
  });

  it("snapshots model catalog provider descriptors during registration", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "catalog-owner",
      name: "Catalog Owner",
      source: "/tmp/catalog-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    let providerReads = 0;
    let kindsReads = 0;
    let staticCatalogReads = 0;

    pluginRegistry.registerModelCatalogProvider(record, {
      get provider() {
        providerReads += 1;
        if (providerReads > 1) {
          throw new Error("provider id getter exploded");
        }
        return "catalog-provider";
      },
      get kinds() {
        kindsReads += 1;
        if (kindsReads > 1) {
          throw new Error("provider kinds getter exploded");
        }
        return ["text"];
      },
      get staticCatalog() {
        staticCatalogReads += 1;
        if (staticCatalogReads > 1) {
          throw new Error("static catalog getter exploded");
        }
        return () => [
          {
            kind: "text",
            provider: "catalog-provider",
            model: "catalog-model",
            source: "static",
          },
        ];
      },
    });

    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogProvider = pluginRegistry.registry.modelCatalogProviders[0]?.provider;
    expect(catalogProvider?.provider).toBe("catalog-provider");
    expect(catalogProvider?.kinds).toEqual(["text"]);
    expect(catalogProvider?.staticCatalog?.({} as never)).toEqual([
      {
        kind: "text",
        provider: "catalog-provider",
        model: "catalog-model",
        source: "static",
      },
    ]);
    expect(providerReads).toBe(1);
    expect(kindsReads).toBe(1);
    expect(staticCatalogReads).toBe(1);
  });

  it("keeps healthy model catalog providers after unreadable registration metadata", () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "catalog-owner",
      name: "Catalog Owner",
      source: "/tmp/catalog-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerModelCatalogProvider(record, {
      get provider() {
        throw new Error("provider id getter exploded");
      },
      kinds: ["text"],
    });
    pluginRegistry.registerModelCatalogProvider(record, {
      provider: "catalog-provider",
      kinds: ["text"],
    });

    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    expect(pluginRegistry.registry.modelCatalogProviders[0]?.provider.provider).toBe(
      "catalog-provider",
    );
    expect(pluginRegistry.registry.diagnostics).toEqual([
      {
        level: "error",
        pluginId: "catalog-owner",
        source: "/tmp/catalog-owner/index.js",
        message: "model catalog provider registration metadata unreadable",
      },
    ]);
  });

  it("combines same-plugin overlapping model catalog hooks", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "catalog-owner",
      name: "Catalog Owner",
      source: "/tmp/catalog-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerModelCatalogProvider(record, {
      provider: "catalog-provider",
      kinds: ["voice"],
      staticCatalog: () => [
        {
          kind: "voice",
          provider: "catalog-provider",
          model: "tts-model",
          source: "static",
        },
      ],
    });
    pluginRegistry.registerModelCatalogProvider(record, {
      provider: "catalog-provider",
      kinds: ["voice"],
      staticCatalog: () => [
        {
          kind: "voice",
          provider: "catalog-provider",
          model: "realtime-model",
          source: "static",
        },
      ],
    });

    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogProvider = pluginRegistry.registry.modelCatalogProviders[0]?.provider;
    await expect(catalogProvider?.staticCatalog?.({} as never)).resolves.toEqual([
      {
        kind: "voice",
        provider: "catalog-provider",
        model: "tts-model",
        source: "static",
      },
      {
        kind: "voice",
        provider: "catalog-provider",
        model: "realtime-model",
        source: "static",
      },
    ]);
  });

  it("publishes text catalog rows for registered provider catalog hooks", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "text-owner",
      name: "Text Owner",
      source: "/tmp/text-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerProvider(record, {
      id: "text-provider",
      label: "Text Provider",
      auth: [],
      catalog: {
        run: async () => ({
          provider: {
            baseUrl: "https://text.example/v1",
            models: [createCatalogModel("text-live", "Text Live")],
          },
        }),
      },
      staticCatalog: {
        run: async () => ({
          provider: {
            baseUrl: "https://text.example/v1",
            models: [createCatalogModel("text-static", "Text Static")],
          },
        }),
      },
    });

    expect(pluginRegistry.registry.providers).toHaveLength(1);
    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogProvider = pluginRegistry.registry.modelCatalogProviders[0]?.provider;
    expect(catalogProvider?.provider).toBe("text-provider");
    expect(catalogProvider?.kinds).toEqual(["text"]);
    await expect(catalogProvider?.staticCatalog?.({} as never)).resolves.toEqual([
      {
        kind: "text",
        provider: "text-provider",
        model: "text-static",
        label: "Text Static",
        source: "static",
      },
    ]);
    await expect(catalogProvider?.liveCatalog?.({} as never)).resolves.toEqual([
      {
        kind: "text",
        provider: "text-provider",
        model: "text-live",
        label: "Text Live",
        source: "live",
      },
    ]);
  });

  it("publishes synthesized media-generation catalog rows during provider registration", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "media-owner",
      name: "Media Owner",
      source: "/tmp/media-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerVideoGenerationProvider(record, {
      id: "video-provider",
      label: "Video Provider",
      defaultModel: "video-default",
      models: ["video-default", "video-pro"],
      capabilities: {
        generate: {
          supportedDurationSeconds: [4, 8],
        },
      },
      generateVideo: async () => ({
        videos: [{ buffer: Buffer.alloc(0), mimeType: "video/mp4" }],
      }),
    });

    expect(pluginRegistry.registry.videoGenerationProviders).toHaveLength(1);
    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogProvider = pluginRegistry.registry.modelCatalogProviders[0]?.provider;
    expect(catalogProvider?.provider).toBe("video-provider");
    expect(catalogProvider?.kinds).toEqual(["video_generation"]);
    const staticRows = await catalogProvider?.staticCatalog?.({} as never);
    expect(staticRows).toHaveLength(2);
    expect(staticRows?.[0]?.kind).toBe("video_generation");
    expect(staticRows?.[0]?.provider).toBe("video-provider");
    expect(staticRows?.[0]?.model).toBe("video-default");
    expect(staticRows?.[0]?.source).toBe("static");
    expect(staticRows?.[0]?.default).toBe(true);
    expect(staticRows?.[0]?.capabilities).toEqual({
      generate: {
        supportedDurationSeconds: [4, 8],
      },
    });
    expect(staticRows?.[1]?.kind).toBe("video_generation");
    expect(staticRows?.[1]?.provider).toBe("video-provider");
    expect(staticRows?.[1]?.model).toBe("video-pro");
    expect(staticRows?.[1]?.source).toBe("static");
  });

  it("publishes synthesized voice catalog rows during speech provider registration", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "speech-owner",
      name: "Speech Owner",
      source: "/tmp/speech-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerSpeechProvider(record, {
      id: "speech-provider",
      label: "Speech Provider",
      defaultModel: "tts-default",
      models: ["tts-default", "tts-pro"],
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.alloc(0),
        fileExtension: "mp3",
        outputFormat: "audio/mpeg",
        voiceCompatible: true,
      }),
    });

    expect(pluginRegistry.registry.speechProviders).toHaveLength(1);
    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogProvider = pluginRegistry.registry.modelCatalogProviders[0]?.provider;
    expect(catalogProvider?.provider).toBe("speech-provider");
    expect(catalogProvider?.kinds).toEqual(["voice"]);
    const staticRows = await catalogProvider?.staticCatalog?.({} as never);
    expect(staticRows).toEqual([
      {
        kind: "voice",
        provider: "speech-provider",
        model: "tts-default",
        label: "Speech Provider",
        source: "static",
        default: true,
        modes: ["tts"],
        capabilities: { tts: true },
      },
      {
        kind: "voice",
        provider: "speech-provider",
        model: "tts-pro",
        label: "Speech Provider",
        source: "static",
        modes: ["tts"],
        capabilities: { tts: true },
      },
    ]);
  });

  it("combines voice catalog rows from speech and realtime providers", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "voice-owner",
      name: "Voice Owner",
      source: "/tmp/voice-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerSpeechProvider(record, {
      id: "voice-provider",
      label: "Voice Provider",
      defaultModel: "tts-default",
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.alloc(0),
        fileExtension: "mp3",
        outputFormat: "audio/mpeg",
        voiceCompatible: true,
      }),
    });
    pluginRegistry.registerRealtimeTranscriptionProvider(record, {
      id: "voice-provider",
      label: "Voice Provider",
      defaultModel: "stt-default",
      isConfigured: () => true,
      createSession: () => ({
        connect: async () => {},
        sendAudio() {},
        close() {},
        isConnected: () => true,
      }),
    });
    pluginRegistry.registerRealtimeVoiceProvider(record, {
      id: "voice-provider",
      label: "Voice Provider",
      defaultModel: "realtime-default",
      isConfigured: () => true,
      createBridge: () => ({
        connect: async () => {},
        sendAudio() {},
        setMediaTimestamp() {},
        submitToolResult() {},
        acknowledgeMark() {},
        close() {},
        isConnected: () => true,
      }),
    });

    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const staticRows =
      await pluginRegistry.registry.modelCatalogProviders[0]?.provider.staticCatalog?.({} as never);
    expect(staticRows?.map((row) => [row.model, row.modes, row.capabilities])).toEqual([
      ["tts-default", ["tts"], { tts: true }],
      ["stt-default", ["realtime_transcription"], { realtime_transcription: true }],
      ["realtime-default", ["realtime_voice"], { realtime_voice: true }],
    ]);
  });

  it("does not duplicate manifest-declared capability provider ids during runtime registration", () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "kitchen-sink",
      name: "Kitchen Sink",
      source: "/tmp/kitchen-sink/index.js",
      origin: "global",
      enabled: true,
      contracts: {
        speechProviders: ["kitchen-sink-speech-provider"],
      },
      configSchema: false,
    });

    pluginRegistry.registerSpeechProvider(record, {
      id: "kitchen-sink-speech-provider",
      label: "Kitchen Sink Speech",
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.alloc(0),
        fileExtension: "mp3",
        outputFormat: "audio/mpeg",
        voiceCompatible: true,
      }),
    });

    expect(record.speechProviderIds).toEqual(["kitchen-sink-speech-provider"]);
    expect(pluginRegistry.registry.speechProviders).toHaveLength(1);
  });
});
