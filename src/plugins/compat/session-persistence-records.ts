import { REPLY_TOOL_AUTHORITY_COMPAT_RECORD } from "./reply-tool-authority-record.js";
import type { PluginCompatRecord } from "./types.js";

export const SESSION_PERSISTENCE_COMPAT_RECORDS = [
  REPLY_TOOL_AUTHORITY_COMPAT_RECORD,
  {
    code: "transcript-lock-sync-message-preparation",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-09-08",
    deprecated: "2026-10-05",
    warningStarts: "2026-10-05",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Use prepareMessageAfterIdempotencyCheckAsync in locked transcript appends. The released synchronous callback retains its result and transaction ordering until the next Plugin SDK major and explicit breaking-release approval. Keep current authority assertions in beforeFreshMessageCommit.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-locked-transcript-preparation",
    surfaces: [
      "SessionTranscriptWriteLockContext.appendMessage.prepareMessageAfterIdempotencyCheck",
      "CodexSessionTranscriptMirrorWriteLockContext.appendMessageWithMessageSequence.prepareMessageAfterIdempotencyCheck",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugin-sdk/session-transcript-lock.native.test.ts",
      "src/plugin-sdk/session-transcript-preparation-compat.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Locked transcript appends can await message preparation and settle accepted operations before releasing the writer. Released synchronous callbacks remain compatible; stored data and update behavior are unchanged.",
  },
  {
    code: "session-upstream-links-sync-persistence",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-07-14",
    deprecated: "2026-10-05",
    warningStarts: "2026-10-05",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await upsertSessionUpstreamLinkAsync and deleteSessionUpstreamLinkAsync from session-catalog. Official harnesses await the native initializer's linkAsync method. Retain the synchronous signatures and completion timing shipped in v2026.9.8 until the next Plugin SDK major and explicit breaking-release approval.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-upstream-links",
    surfaces: [
      "openclaw/plugin-sdk/session-catalog.upsertSessionUpstreamLink",
      "openclaw/plugin-sdk/session-catalog.deleteSessionUpstreamLink",
      "openclaw/plugin-sdk/agent-harness-session-runtime.createNativeSessionInitializationOwner().prepare().link",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugin-sdk/session-catalog-upstream-compat.test.ts",
      "src/plugin-sdk/agent-harness-session-compat.test.ts",
      "src/sessions/session-upstream-links.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Bundled session adoption and native initialization await upstream-link writes through the shared-state worker. Released synchronous SDK methods remain compatible until the next Plugin SDK major; schemas, stored data, retention, and update behavior are unchanged.",
  },
  {
    code: "session-observer-progress-sync-reads",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-09-08",
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await sessionObserver.handleEventAsync, getCompanionSnapshotAsync, and disposeAsync. Use reply_dispatch shouldSendToolSummariesAsync/shouldSendFullToolDetailsAsync and onVerboseProgressVisibilityAsync. Retain synchronous contracts until the next Plugin SDK major and explicit breaking-release approval.",
    docsPath:
      "/plugins/sdk-migration/how-to-migrate#await-session-observer-and-progress-visibility",
    surfaces: [
      "GatewayRequestHandlerOptions.context.sessionObserver.handleEvent",
      "GatewayRequestHandlerOptions.context.sessionObserver.getCompanionSnapshot",
      "GatewayRequestHandlerOptions.context.sessionObserver.dispose",
      "PluginHookReplyDispatchEvent.shouldSendToolSummaries",
      "PluginHookReplyDispatchEvent.shouldSendFullToolDetails",
      "GetReplyOptions.onVerboseProgressVisibility",
      "tryDispatchAcpReplyHook boolean-only event inputs",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "src/plugin-sdk/reply-runtime.contract.test.ts",
      "src/plugin-sdk/gateway-session-observer-compat.test.ts",
      "src/plugin-sdk/acp-runtime.test.ts",
      "src/gateway/session-observer.test.ts",
    ],
    releaseNote:
      "Session observer lifecycle and progress visibility expose awaited worker-backed methods. Released synchronous observer methods, reply-hook booleans, and visibility callbacks remain compatible; schemas, stored data, retention, and update behavior are unchanged.",
  },
  {
    code: "channel-inbound-sync-envelope-timestamps",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-10-05",
    deprecated: "2026-10-05",
    warningStarts: "2026-10-05",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await readSessionUpdatedAtAsync, createChannelInboundEnvelopeBuilderAsync, or resolveInboundSessionEnvelopeContextAsync at each message's formatting boundary. Resolve routes through resolveAgentRoute and use dispatchInboundDirectDm. Retain the synchronous signatures and callback timing shipped in 2026.9.8 until the next Plugin SDK major and explicit breaking-release approval.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#inbound-envelope-timestamps",
    surfaces: [
      "openclaw/plugin-sdk/session-store-runtime.readSessionUpdatedAt",
      "api.runtime.channel.session.readSessionUpdatedAt",
      "openclaw/plugin-sdk/channel-inbound.createChannelInboundEnvelopeBuilder",
      "openclaw/plugin-sdk/channel-inbound.resolveChannelInboundRouteEnvelope",
      "openclaw/plugin-sdk/channel-inbound.resolveInboundSessionEnvelopeContext",
      "openclaw/plugin-sdk/channel-inbound.dispatchInboundDirectDmWithRuntime",
      "openclaw/plugin-sdk/inbound-envelope.createInboundEnvelopeBuilder",
      "openclaw/plugin-sdk/inbound-envelope.resolveInboundRouteEnvelopeBuilder",
      "openclaw/plugin-sdk/inbound-envelope.resolveInboundRouteEnvelopeBuilderWithRuntime",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugin-sdk/shipped-channel-compat.test.ts",
      "src/channels/inbound-event/envelope.test.ts",
      "src/channels/inbound-event/envelope.worker.test.ts",
      "src/plugin-sdk/direct-dm.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Bundled channels prepare activity timestamps through the existing session reader while released plugins retain their synchronous envelope callbacks. Stored data, schemas, retention, and update behavior are unchanged.",
  },
  {
    code: "reply-run-start-unprepared-transcript",
    status: "deprecated",
    owner: "agent-runtime",
    introduced: "2026-10-04",
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Forward every onAgentRunStart argument and its synchronous return value through the current runtime helper. Bundled producers supply prepared transcript facts in the optional fourth argument; retain the released three-argument callback and synchronous transcript-read fallback until the next Plugin SDK major and explicit breaking-release approval.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#reply-run-start-transcript-facts",
    surfaces: [
      "openclaw/plugin-sdk/reply-runtime.GetReplyOptions.onAgentRunStart",
      "PluginHookReplyDispatchContext.onAgentRunStart",
    ],
    diagnostics: ["plugin compatibility registry and migration documentation; no runtime warnings"],
    tests: [
      "src/plugin-sdk/reply-runtime.contract.test.ts",
      "src/gateway/server-methods/chat-send-reply-dispatch.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Reply runtimes can pass prepared transcript boundaries without Gateway-thread reads. Released plugin callbacks keep their arguments and synchronous completion acknowledgment; stored data and update behavior are unchanged.",
  },
  {
    code: "session-manager-sync-context-read",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-10-04",
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await SessionManager.readSessionContextAsync for full-fidelity context consumption. The synchronous reader retains its shipped result until the next Plugin SDK major and explicit breaking-release approval.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence",
    surfaces: ["SessionManager.readSessionContext"],
    diagnostics: [
      "TypeScript @deprecated annotation and one runtime DEP_SESSION_PERSISTENCE warning per method per process",
    ],
    tests: [
      "src/plugin-sdk/agent-sessions.context-compat.test.ts",
      "src/agents/sessions/session-manager-incognito.test.ts",
      "src/agents/sessions/session-manager-model-context-snapshot.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Plugins can await full-fidelity SessionManager context reads and asynchronous consumers. Source validation follows consumption; the synchronous reader remains available until the next Plugin SDK major. Storage and update behavior are unchanged.",
  },
  {
    code: "session-reset-freshness-sync-read",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-10-05",
    deprecated: "2026-10-05",
    warningStarts: "2026-10-05",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await runtime.channel.session.resolveEntryResetFreshnessAsync. The released synchronous resolveEntryResetFreshness method retains its parameters and result until the next Plugin SDK major and explicit breaking-release approval.",
    docsPath: "/plugins/sdk-migration#session-reset-freshness",
    surfaces: ["api.runtime.channel.session.resolveEntryResetFreshness"],
    diagnostics: [
      "TypeScript @deprecated annotation and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugin-sdk/session-reset-freshness-compat.test.ts",
      "src/config/sessions/entry-freshness.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Channel plugins can await session reset freshness through the transcript worker. Existing plugins retain the synchronous method and reset policy; stored data and update behavior are unchanged.",
  },
  {
    code: "agent-end-sync-side-effects",
    status: "deprecated",
    owner: "agent-runtime",
    introduced: "2026-05-30",
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await runAgentEndSideEffectsAsync before releasing the turn lease. The released runAgentEndSideEffects helper retains its synchronous void result and scheduling behavior until the next Plugin SDK major and explicit breaking-release approval.",
    docsPath: "/plugins/sdk-agent-harness/attempt-runtime#agent-end-side-effects",
    surfaces: ["openclaw/plugin-sdk/agent-harness-runtime.runAgentEndSideEffects"],
    diagnostics: [
      "TypeScript @deprecated annotation and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugin-sdk/agent-harness-runtime.test.ts",
      "src/agents/harness/agent-end-side-effects.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Harness plugins can await transcript-anchor preparation before releasing turn authority. The synchronous agent-end helper remains compatible for published plugins; stored data and update behavior are unchanged.",
  },
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
  {
    code: "acp-session-metadata-released-signatures",
    status: "active",
    owner: "sdk",
    introduced: "2026-10-04",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Keep the released one-argument ACP reader and manager read/write injection signatures. Internal actor bindings are not plugin arguments; actor activation must preserve these callable contracts. The APIs remain supported and are not deprecated.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#acp-metadata-binding-compatibility",
    surfaces: [
      "openclaw/plugin-sdk/acp-runtime.readAcpSessionEntryAsync",
      "AcpSessionManagerDeps.loadSessionEntryAsync",
      "AcpSessionManagerDeps.upsertSessionMeta",
    ],
    diagnostics: ["SDK type assertions and compatibility documentation; no runtime warnings"],
    tests: [
      "src/plugin-sdk/acp-runtime.test.ts",
      "src/acp/runtime/session-meta-read.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Released ACP readers and manager injection callbacks keep their one-argument contracts while incognito actor composition remains internal and inactive.",
  },
  {
    code: "memory-session-released-signatures",
    status: "active",
    owner: "sdk",
    introduced: "2026-10-05",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Keep the released Memory entry, corpus, and reset-recall reader signatures. Internal actor sources are not plugin arguments; actor activation must preserve the existing Promise results and synchronous message observers. These APIs remain supported and are not deprecated.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#memory-session-binding-compatibility",
    surfaces: [
      "openclaw/plugin-sdk/memory-core-host-engine-sessions.buildSessionEntry",
      "openclaw/plugin-sdk/memory-core-host-engine-sessions.listSessionTranscriptCorpusEntriesForAgent",
      "openclaw/plugin-sdk/memory-core-host-engine-sessions.readSessionResetRecallCutoff",
    ],
    diagnostics: ["SDK type assertions and compatibility documentation; no runtime warnings"],
    tests: [
      "src/plugin-sdk/memory-core-host-engine-sessions.contract.test.ts",
      "src/state/openclaw-agent-execution-incognito.memory.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Released Memory readers retain their argument and return contracts while incognito actor sources remain internal and inactive. Storage and update behavior are unchanged.",
  },
  {
    code: "transcript-strict-sync-message-preparation",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-09-08",
    deprecated: "2026-10-05",
    warningStarts: "2026-10-05",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Use prepareMessageAfterIdempotencyCheckAsync with appendSessionTranscriptMessageByIdentityStrict. The released synchronous callback retains its result and transaction ordering until the next Plugin SDK major and explicit breaking-release approval. Keep live authority assertions in beforeFreshMessageCommit.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-strict-transcript-message-preparation",
    surfaces: [
      "appendSessionTranscriptMessageByIdentityStrict.prepareMessageAfterIdempotencyCheck",
    ],
    diagnostics: [
      "TypeScript @deprecated annotation and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugin-sdk/session-transcript-runtime.worker-preparation.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Strict transcript preparation can await work outside the existing writer transaction. Released synchronous callbacks remain compatible; stored data and update behavior are unchanged.",
  },
] as const satisfies readonly PluginCompatRecord[];
