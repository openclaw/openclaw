import type { PluginCompatRecord } from "./types.js";

export const SESSION_PERSISTENCE_COMPAT_RECORDS = [
  {
    code: "native-session-generation-sync-authority",
    status: "deprecated",
    owner: "agent-runtime",
    introduced: "2026-09-22",
    deprecated: "2026-10-03",
    warningStarts: "2026-10-03",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await prepareNativeSessionGenerationAuthority, resolveNativeSessionBindingWithAuthority, and reclaimNativeSessionGenerationWithAuthority with NativeSessionGenerationOperationsV2. Retain released synchronous capture and two-argument mutation callbacks until published official harness readers migrate and a breaking release is explicitly approved.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#native-session-generation-authority",
    surfaces: [
      "captureNativeSessionGenerationAuthority",
      "resolveNativeSessionBinding",
      "reclaimNativeSessionGeneration",
      "NativeSessionGenerationOperations",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugin-sdk/agent-harness-session-compat.test.ts",
      "src/agents/harness/native-session/binding-generation.test.ts",
      "src/agents/harness/native-session/binding-generation-authority.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Native harnesses can admit binding operations through worker-backed session authority. Released official harness plugins retain synchronous authority capture and lineage-checking mutation callbacks across host upgrades.",
  },
  {
    code: "session-manager-sync-persistence",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-10-01",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await the matching Async-suffixed SessionManager method, including the returned rewrite commit. Retain synchronous adapters only for shipped third-party contracts until the next Plugin SDK major and explicit breaking-release approval.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence",
    surfaces: [
      "SessionManager.appendMessage",
      "SessionManager.appendMessageWithTranscriptAnchor",
      "SessionManager.appendCompaction",
      "SessionManager.appendResetBoundary",
      "SessionManager.appendCustomEntry",
      "SessionManager.appendSessionInfo",
      "SessionManager.appendCustomMessageEntry",
      "SessionManager.appendLeafControl",
      "SessionManager.appendLabelChange",
      "SessionManager.branch",
      "SessionManager.branchWithSummary",
      "SessionManager.removeTrailingEntries",
      "SessionManager.persist",
      "SessionManager.prepareTranscriptRewrite",
      "SessionManager.appendMessageToTranscript",
      "SessionManager.open",
      "SessionManager.openBounded",
      "SessionManager.openDetachedBounded",
      "SessionManager.openModelContext",
      "SessionManager.setSessionTarget",
      "SessionManager.reloadPersistedTranscript",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations naming awaited twins",
      "one runtime DEP_SESSION_PERSISTENCE warning per method per process",
    ],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "src/agents/sessions/session-manager-async-entries.test.ts",
      "src/agents/sessions/session-manager-async-message.test.ts",
      "src/agents/sessions/session-manager-maintenance-async.test.ts",
    ],
    releaseNote:
      "Plugins can await SessionManager transcript mutations through the existing SQLite worker. Synchronous methods retain their shipped return values as deprecated third-party adapters until the next Plugin SDK major; storage formats and update behavior are unchanged.",
  },
  {
    code: "extension-session-sync-persistence",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-10-01",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await ExtensionAPI.appendEntryAsync, setSessionNameAsync, and setLabelAsync, and AgentSession.setSessionNameAsync. Existing synchronous third-party methods retain their void return contract until the next Plugin SDK major and explicit breaking-release approval.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-extension-session-changes",
    surfaces: [
      "ExtensionAPI.appendEntry",
      "ExtensionAPI.setSessionName",
      "ExtensionAPI.setLabel",
      "AgentSession.setSessionName",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations, migration guide, and once-per-method DEP_SESSION_PERSISTENCE warning",
    ],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "src/agents/sessions/sdk.metadata-admission.test.ts",
    ],
    releaseNote:
      "Extensions can await transcript entries, session names, and labels; the shipped synchronous methods remain third-party compatibility adapters through the next Plugin SDK major.",
  },
  {
    code: "provider-replay-sync-persistence",
    status: "deprecated",
    owner: "provider",
    introduced: "2026-10-01",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Use ProviderPlugin.sanitizeReplayHistoryAsync with ProviderSanitizeReplayHistoryContextV2 and await ProviderReplaySessionStateV2.appendCustomEntryAsync; use sanitizeGoogleGeminiReplayHistoryAsync for the shared Gemini implementation. Retain legacy third-party contexts and hooks until the next Plugin SDK major and explicit breaking-release approval.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-provider-replay-metadata",
    surfaces: [
      "ProviderPlugin.sanitizeReplayHistory",
      "ProviderReplaySessionState.appendCustomEntry",
      "sanitizeGoogleGeminiReplayHistory",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations, versioned migration guide, and once-per-method DEP_SESSION_PERSISTENCE warning",
    ],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "src/plugins/provider-replay-helpers.test.ts",
      "src/plugins/provider-runtime.test.ts",
      "src/plugin-sdk/provider-model-shared.test.ts",
    ],
    releaseNote:
      "Provider replay hooks can await committed transcript metadata through additive V2 context types. Legacy hooks, context types, and the synchronous Gemini helper remain available for third-party migration through the next Plugin SDK major.",
  },
] as const satisfies readonly PluginCompatRecord[];
