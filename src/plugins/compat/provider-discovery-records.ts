import type { PluginCompatRecord } from "./types.js";

const DISCOVERY_MIGRATION = {
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-01",
  deprecated: "2026-10-12",
  warningStarts: "2026-10-12",
} as const;

export const PROVIDER_DISCOVERY_COMPAT_RECORDS = [
  {
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-10-01",
    deprecated: "2026-10-12",
    warningStarts: "2026-10-12",
    code: "sandbox-env-sync",
    replacement:
      "Await sanitizeEnvVarsAsync from openclaw/plugin-sdk/sandbox. The synchronous sanitizeEnvVars helper retains native metadata discovery during its stable deprecation window.",
    docsPath: "/plugins/sdk-migration#sandbox-environment-filtering",
    surfaces: ["openclaw/plugin-sdk/sandbox sanitizeEnvVars"],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous sandbox env filtering"],
    tests: ["src/agents/sandbox/sanitize-env-vars.metadata.test.ts"],
  },
  {
    ...DISCOVERY_MIGRATION,
    code: "provider-http-sync-policy",
    replacement:
      "Await prepareModelProviderRequestRouteFacts and pass its providerMetadataOwners to endpoint and request policy helpers. Synchronous SDK helpers retain cold native metadata discovery until a later release after stable deprecation.",
    docsPath: "/plugins/sdk-migration#bundled-provider-request-policy",
    surfaces: [
      "openclaw/plugin-sdk/provider-http resolveProviderEndpoint",
      "openclaw/plugin-sdk/provider-http resolveProviderRequestPolicy",
      "openclaw/plugin-sdk/provider-http resolveProviderRequestCapabilities",
      "openclaw/plugin-sdk/provider-model-shared resolveProviderEndpoint",
    ],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous provider HTTP policy"],
    tests: ["src/plugin-sdk/provider-http-compat.test.ts"],
  },
  {
    ...DISCOVERY_MIGRATION,
    code: "provider-catalog-sync-discovery",
    replacement:
      "Await resolvePluginProvidersAsync. The synchronous resolvePluginProviders export remains available for an already prepared and loaded provider registry; it does not perform cold native discovery.",
    docsPath: "/plugins/sdk-migration#provider-discovery",
    surfaces: ["openclaw/plugin-sdk/provider-catalog-runtime resolvePluginProviders"],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous provider selection"],
    tests: ["src/plugin-sdk/provider-catalog-runtime.test.ts"],
  },
  {
    ...DISCOVERY_MIGRATION,
    code: "realtime-voice-registry-sync",
    replacement:
      "Await getRealtimeVoiceProviderAsync, listRealtimeVoiceProvidersAsync, canonicalizeRealtimeVoiceProviderIdAsync, or resolveConfiguredRealtimeVoiceProviderAsync. Synchronous SDK counterparts retain cold native discovery until a later release after stable deprecation.",
    docsPath: "/plugins/sdk-migration#realtime-voice-provider-discovery",
    surfaces: [
      "openclaw/plugin-sdk/realtime-voice getRealtimeVoiceProvider",
      "openclaw/plugin-sdk/realtime-voice listRealtimeVoiceProviders",
      "openclaw/plugin-sdk/realtime-voice canonicalizeRealtimeVoiceProviderId",
      "openclaw/plugin-sdk/realtime-voice resolveConfiguredRealtimeVoiceProvider",
    ],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous realtime voice discovery"],
    tests: ["src/talk/provider-registry-sdk.test.ts"],
  },
  {
    ...DISCOVERY_MIGRATION,
    code: "realtime-transcription-registry-sync",
    replacement:
      "Await getRealtimeTranscriptionProviderAsync or listRealtimeTranscriptionProvidersAsync. Synchronous counterparts require already prepared and loaded transcription providers; they do not perform cold native discovery.",
    docsPath: "/plugins/sdk-migration#realtime-transcription-provider-discovery",
    surfaces: [
      "openclaw/plugin-sdk/realtime-transcription getRealtimeTranscriptionProvider",
      "openclaw/plugin-sdk/realtime-transcription listRealtimeTranscriptionProviders",
    ],
    diagnostics: [
      "Bounded DEP_PLUGIN_SDK warning for synchronous realtime transcription discovery",
    ],
    tests: [
      "extensions/voice-call/src/webhook.provider-discovery.test.ts",
      "src/gateway/talk/handlers/index.test.ts",
    ],
  },
  {
    ...DISCOVERY_MIGRATION,
    code: "speech-registry-sync",
    replacement:
      "Await getSpeechProviderAsync, listSpeechProvidersAsync, canonicalizeSpeechProviderIdAsync, getResolvedSpeechProviderConfigAsync, resolveTtsProviderOrderAsync, and setTtsProviderAsync. Synchronous counterparts require an already prepared provider registry or an explicit prepared inventory; they do not perform cold native discovery.",
    docsPath: "/plugins/sdk-migration#speech-provider-discovery",
    surfaces: [
      "openclaw/plugin-sdk/speech getSpeechProvider",
      "openclaw/plugin-sdk/speech-core getSpeechProvider",
      "openclaw/plugin-sdk/speech-core listSpeechProviders",
      "openclaw/plugin-sdk/speech-core canonicalizeSpeechProviderId",
      "openclaw/plugin-sdk/tts-runtime getResolvedSpeechProviderConfig",
      "openclaw/plugin-sdk/tts-runtime resolveTtsProviderOrder",
      "openclaw/plugin-sdk/tts-runtime setTtsProvider",
    ],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warnings for synchronous speech registry operations"],
    tests: ["src/tts/provider-registry.test.ts", "src/gateway/server-methods/tts.test.ts"],
  },
  {
    ...DISCOVERY_MIGRATION,
    code: "embedding-registry-sync",
    replacement:
      "Await getEmbeddingProviderAsync, listEmbeddingProvidersAsync, getMemoryEmbeddingProviderAsync, listMemoryEmbeddingProvidersAsync, and resolveMemorySearchConfigAsync on their existing subpaths. Synchronous counterparts require prepared provider facts and do not perform cold native discovery.",
    docsPath: "/plugins/sdk-migration/removed-surfaces#migration-reference",
    surfaces: [
      "openclaw/plugin-sdk/embedding-providers getEmbeddingProvider",
      "openclaw/plugin-sdk/embedding-providers listEmbeddingProviders",
      "openclaw/plugin-sdk/memory-core-host-engine-embeddings getMemoryEmbeddingProvider",
      "openclaw/plugin-sdk/memory-core-host-embedding-registry listMemoryEmbeddingProviders",
      "openclaw/plugin-sdk/memory-core-host-engine-foundation resolveMemorySearchConfig",
      "openclaw/plugin-sdk/memory-core-host-runtime-core resolveMemorySearchConfig",
    ],
    diagnostics: ["Bounded DEP_PLUGIN_SDK warnings for synchronous embedding discovery"],
    tests: ["src/plugins/embedding-provider-runtime.test.ts", "src/agents/memory-search.test.ts"],
  },
] as const satisfies readonly PluginCompatRecord[];
