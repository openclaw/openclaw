import type { PluginCompatRecord } from "./types.js";

/**
 * JavaScript-only SDK facades are not typed contracts, but published plugins link these names;
 * the contract test asserts each surface stays exported from its packaged subpath.
 */
export const PLUGIN_SDK_PRIVATE_RUNTIME_EXPORT_COMPAT_RECORD = {
  code: "plugin-sdk-private-runtime-shipped-exports",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-15",
  deprecated: "2026-10-15",
  warningStarts: "2026-10-15",
  removeAfter: "2027-01-15",
  replacement:
    "Import the helper from a typed public SDK subpath that exports it, or keep a plugin-local copy; these JavaScript-only runtime facades are not a typed third-party contract",
  docsPath: "/plugins/sdk-migration/compatibility-policy#private-runtime-facade-exports",
  surfaces: [
    "openclaw/plugin-sdk/acp-runtime.getAcpRuntimeBackend",
    "openclaw/plugin-sdk/approval-reaction-runtime.readApprovalReactionDeliveryMetadata",
    "openclaw/plugin-sdk/fetch-runtime.hasEnvHttpProxyConfigured",
    "openclaw/plugin-sdk/image-generation-core.resolveAgentModelPrimaryValue",
    "openclaw/plugin-sdk/image-generation-core.resolveApiKeyForProvider",
    "openclaw/plugin-sdk/memory-core-host-engine-embeddings.fetchRemoteEmbeddingVectors",
    "openclaw/plugin-sdk/memory-core-host-engine-embeddings.listMemoryEmbeddingProviders",
    "openclaw/plugin-sdk/memory-core-host-engine-storage.chunkMarkdown",
    "openclaw/plugin-sdk/memory-core-host-engine-storage.ensureDir",
    "openclaw/plugin-sdk/memory-core-host-runtime-files.listMemoryFiles",
    "openclaw/plugin-sdk/memory-core-host-runtime-files.normalizeExtraMemoryPaths",
    "openclaw/plugin-sdk/poll-runtime.resolvePollMaxSelections",
    "openclaw/plugin-sdk/provider-stream.createOpenRouterSystemCacheWrapper",
    "openclaw/plugin-sdk/provider-stream.resolveMoonshotThinkingType",
    "openclaw/plugin-sdk/provider-web-fetch.enablePluginInConfig",
    "openclaw/plugin-sdk/provider-web-fetch.jsonResult",
    "openclaw/plugin-sdk/provider-web-fetch.withTrustedWebToolsEndpoint",
    "openclaw/plugin-sdk/provider-web-fetch.wrapExternalContent",
    "openclaw/plugin-sdk/provider-web-fetch.wrapWebContent",
    "openclaw/plugin-sdk/provider-web-search.DEFAULT_TIMEOUT_SECONDS",
    "openclaw/plugin-sdk/provider-web-search.markdownToText",
    "openclaw/plugin-sdk/provider-web-search.setScopedCredentialValue",
    "openclaw/plugin-sdk/provider-web-search.setTopLevelCredentialValue",
    "openclaw/plugin-sdk/retry-runtime.createRateLimitRetryRunner",
    "openclaw/plugin-sdk/speech.readResponseTextLimited",
    "openclaw/plugin-sdk/speech.truncateErrorDetail",
    "openclaw/plugin-sdk/thread-bindings-runtime.resolveThreadBindingConversationIdFromBindingId",
    "openclaw/plugin-sdk/thread-bindings-runtime.resolveThreadBindingFarewellText",
    "openclaw/plugin-sdk/thread-bindings-runtime.resolveThreadBindingLifecycle",
  ],
  diagnostics: [
    "TypeScript @deprecated annotations and the private runtime shipped-export contract test",
  ],
  tests: [
    "src/plugin-sdk/private-runtime-shipped-exports.test.ts",
    "src/plugins/compat/registry.test.ts",
  ],
  releaseNote:
    "Runtime exports that published plugins import from JavaScript-only `openclaw/plugin-sdk/*` facades, such as `readApprovalReactionDeliveryMetadata`, are restored after 2026.10.5 betas removed them; they remain deprecated through 2027-01-15.",
} as const satisfies PluginCompatRecord;
