import { REPLY_TOOL_AUTHORITY_COMPAT_RECORD } from "./reply-tool-authority-record.js";
import { TRANSCRIPT_STATS_COMPAT_RECORD } from "./transcript-stats-record.js";
import type { PluginCompatRecord } from "./types.js";

const DEPRECATED_SESSION_COMPAT = {
  status: "deprecated",
  owner: "sdk",
  removalGate: "after-stable-deprecation",
  diagnostics: [
    "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
  ],
} as const;

const REMOVED_SESSION_COMPAT = {
  status: "removed",
  owner: "sdk",
  diagnostics: ["plugin compatibility registry and migration guide"],
} as const;

export const SESSION_PERSISTENCE_COMPAT_RECORDS = [
  REPLY_TOOL_AUTHORITY_COMPAT_RECORD,
  TRANSCRIPT_STATS_COMPAT_RECORD,
  {
    code: "github-publication-sync-orphan-deferral",
    ...REMOVED_SESSION_COMPAT,
    introduced: "2026-10-12",
    replacement: "Await githubPublicationService.deferOrphanedRequestsAsync.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-github-publication-operations",
    surfaces: [
      "GatewayRequestHandlerOptions.context.githubPublicationService.deferOrphanedRequests",
    ],
    tests: [
      "src/gateway/github-publication-boundaries.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Removes synchronous GitHub orphan deferral first deprecated in stable v2026.10.1. Other publication and OAuth compatibility methods remain deprecated until their own stable deprecation period is complete.",
  },
  {
    code: "proxy-capture-sync-persistence",
    ...REMOVED_SESSION_COMPAT,
    introduced: "2026-10-12",
    replacement:
      "Call acquireDebugProxyCaptureStoreAsync and await the lease's release. Use createDebugProxyCaptureReaderAsync, initializeDebugProxyCaptureAsync, captureHttpExchangeAsync, captureWsEventAsync, and finalizeDebugProxyCaptureAsync.",
    docsPath: "/plugins/sdk-migration/deprecated-sqlite",
    surfaces: [
      "openclaw/plugin-sdk/proxy-capture.DebugProxyCaptureReader",
      "openclaw/plugin-sdk/proxy-capture.DebugProxyCaptureStore",
      "openclaw/plugin-sdk/proxy-capture.getDebugProxyCaptureStore",
      "openclaw/plugin-sdk/proxy-capture.acquireDebugProxyCaptureStore",
      "openclaw/plugin-sdk/proxy-capture.closeDebugProxyCaptureStore",
      "openclaw/plugin-sdk/proxy-capture.createDebugProxyCaptureReader",
      "openclaw/plugin-sdk/proxy-capture.initializeDebugProxyCapture",
      "openclaw/plugin-sdk/proxy-capture.captureHttpExchange",
      "openclaw/plugin-sdk/proxy-capture.captureWsEvent",
      "openclaw/plugin-sdk/proxy-capture.finalizeDebugProxyCapture",
    ],
    tests: [
      "src/proxy-capture/store.async.test.ts",
      "src/proxy-capture/runtime.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Removes synchronous proxy capture storage, readers, and lifecycle APIs first deprecated in stable v2026.9.7. Capture uses the existing async worker and explicit lease release; stored capture data is unchanged.",
  },
  {
    code: "session-store-sync-listing",
    ...DEPRECATED_SESSION_COMPAT,
    introduced: "2026-09-08",
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    replacement:
      "Await listSessionEntriesAsync with an explicit agentId for read-only metadata; use getSessionEntryAsync for complete entries. Retain final deletion and disclosure authority at the effect boundary. The synchronous listing remains compatible until removal after stable deprecation and a compatibility period.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-metadata-listings",
    surfaces: [
      "openclaw/plugin-sdk/session-store-runtime.listSessionEntries",
      "api.runtime.agent.session.listSessionEntries",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and one shared DEP_PLUGIN_SDK warning per plugin and session-store family per process on legacy use",
    ],
    tests: [
      "src/plugin-sdk/session-store-runtime.async.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Plugins can list current session metadata through the existing session worker without loading saved prompts or creating missing databases. Bundled Discord thread-close and Codex pre-archive enumeration use the async API; the released synchronous contract remains available. Stored data and update behavior are unchanged.",
  },
  {
    code: "github-publication-native-callbacks",
    ...DEPRECATED_SESSION_COMPAT,
    introduced: "2026-08-19",
    deprecated: "2026-10-09",
    warningStarts: "2026-10-09",
    replacement:
      "Use requestForSessionV2 and requestForClaimV2 with the host-provided GitHubPublicationRequesterV2, and requestPersonalForSessionV2 and confirmPersonalV2 with PersonalGitHubSessionActionV2. Await deferClaimPreparationAsync, listUnreportedResultsAsync, markReportedAsync, readAsync, and personalStatusAsync. Legacy publication methods retain their signatures but fail at invocation. On githubOAuthService, await cancelAuthorizationAsync and retireProfileAsync; on its personal service, await cancelAuthorizationAsync and disconnectAsync. These OAuth compatibility methods retain synchronous completion. Deprecated signatures will be removed in a later normal release after stable deprecation and a compatibility period.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-github-publication-operations",
    surfaces: [
      "GatewayRequestHandlerOptions.context.githubPublicationService.requestForSession",
      "GatewayRequestHandlerOptions.context.githubPublicationService.requestForClaim",
      "GatewayRequestHandlerOptions.context.githubPublicationService.requestPersonalForSession",
      "GatewayRequestHandlerOptions.context.githubPublicationService.confirmPersonal",
      "GatewayRequestHandlerOptions.context.githubPublicationService.deferClaimPreparation",
      "GatewayRequestHandlerOptions.context.githubPublicationService.listUnreportedResults",
      "GatewayRequestHandlerOptions.context.githubPublicationService.markReported",
      "GatewayRequestHandlerOptions.context.githubPublicationService.personalStatus",
      "GatewayRequestHandlerOptions.context.githubOAuthService.cancelAuthorization",
      "GatewayRequestHandlerOptions.context.githubOAuthService.retireProfile",
      "GatewayRequestHandlerOptions.context.githubOAuthService.personal.cancelAuthorization",
      "GatewayRequestHandlerOptions.context.githubOAuthService.personal.disconnect",
      "GitHubPublicationRequester",
      "GitHubPublicationRequesterPolicy",
      "PersonalGitHubSessionAction",
      "getPluginRuntimeGatewayRequestScope().context.githubPublicationService",
      "getPluginRuntimeGatewayRequestScope().context.githubOAuthService.personal",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations naming the V2 or Async replacement; one shared runtime DEP_PLUGIN_SDK warning per plugin and github-publication family per process, including bounded unscoped SDK use",
    ],
    tests: [
      "src/plugin-sdk/gateway-placement-compat.test.ts",
      "src/state/github-publication.worker.test.ts",
      "src/gateway/github-publication-admission.test.ts",
      "src/gateway/server-methods/users-github.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "GitHub publication adds required V2 requester capabilities and worker-owned request, lifecycle, execution, recovery, and reporting commands. Legacy publication methods retain their signatures but fail at invocation with migration guidance until removal after stable deprecation and a compatibility period. Personal connection cancellation and disconnection add awaited worker methods while retaining their released synchronous contracts; schemas, stored data, retention, and update behavior are unchanged.",
  },
  {
    code: "session-store-opaque-mutations",
    ...DEPRECATED_SESSION_COMPAT,
    introduced: "2026-09-08",
    deprecated: "2026-10-09",
    warningStarts: "2026-10-09",
    replacement:
      "Use prepareSessionEntryPatch for host preparation followed by an exact-snapshot conditional commit, applySessionEntryPatch for data-only patches, and updateLastRouteWithAuthority for guarded route updates. Legacy opaque transaction guards retain their ordering and will be removed in a later normal release after stable deprecation and a compatibility period.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#prepare-session-entry-changes",
    surfaces: [
      "openclaw/plugin-sdk/session-store-runtime.patchSessionEntry",
      "openclaw/plugin-sdk/session-store-runtime.updateSessionStoreEntry",
      "openclaw/plugin-sdk/session-store-runtime.updateLastRoute.assertCommitAllowed",
      "api.runtime.agent.session.patchSessionEntry",
      "api.runtime.agent.session.updateSessionStoreEntry",
      "api.runtime.channel.session.updateLastRoute.assertCommitAllowed",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and one shared DEP_PLUGIN_SDK warning per plugin and session-store family per process on legacy use",
    ],
    tests: [
      "src/plugin-sdk/session-persistence-compat.test.ts",
      "src/plugin-sdk/session-store-runtime.worker-patch.test.ts",
      "src/plugin-sdk/session-store-runtime.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Plugins can prepare entry changes outside SQLite or submit conditional data patches to the existing worker. Public upserts and transcript watermarks use typed worker reducers. Released callback contracts remain compatible; native incognito and cross-store adapters retain their separate cutover boundaries.",
  },
  {
    code: "codex-transcript-sync-validation",
    ...DEPRECATED_SESSION_COMPAT,
    introduced: "2026-09-08",
    deprecated: "2026-10-06",
    warningStarts: "2026-10-06",
    replacement:
      "Await readCodexSessionContextProjection for retained worker projection and final validation. Keep the released synchronous validators until removal after stable deprecation and a compatibility period. readCodexSessionContext remains a supported synchronous worker reader with its released three-argument generic result contract.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence",
    surfaces: [
      "openclaw/plugin-sdk/codex-session-transcript-runtime.validateCodexSessionTranscriptReadAdmission",
      "openclaw/plugin-sdk/codex-session-transcript-runtime.validateCodexSessionTranscriptContextVersion",
    ],
    tests: [
      "src/plugin-sdk/codex-session-transcript-runtime.compat.test.ts",
      "src/config/sessions/session-transcript-context-read.worker.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Codex history validates retained worker projections off the Gateway thread while preserving the released synchronous reader and validator signatures. Storage and update behavior are unchanged.",
  },
  {
    code: "deprecated-session-store-beta5-api",
    status: "removed",
    removeAfter: "2026-09-30",
    owner: "sdk",
    introduced: "2026-05-21",
    deprecated: "2026-07-12",
    warningStarts: "2026-07-12",
    replacement:
      "Use `getSessionEntry(...)` and `listSessionEntries(...)` for reads; `patchSessionEntry(...)`, `upsertSessionEntry(...)`, and `deleteSessionEntry(...)` for row mutations; and session identity with `session-transcript-runtime` for active transcripts. The supported-plugin cutoff excludes v2026.7.1-beta.5 and other packages importing the retired bridge.",
    docsPath: "/plugins/sdk-migration/removed-surfaces#removed-session-and-transcript-file-apis",
    surfaces: [
      "openclaw/plugin-sdk/session-store-runtime loadSessionStore",
      "openclaw/plugin-sdk/session-store-runtime updateSessionStore",
      "openclaw/plugin-sdk/session-store-runtime resolveSessionFilePath",
      "openclaw/plugin-sdk/session-store-runtime resolveSessionStoreEntry",
      "openclaw/plugin-sdk/session-store-runtime LoadSessionStoreOptions",
      "openclaw/plugin-sdk/session-store-runtime UpdateSessionStoreOptions",
      "openclaw package root loadSessionStore",
      "openclaw package root saveSessionStore",
    ],
    diagnostics: ["plugin compatibility registry and migration guide"],
    tests: [
      "src/plugin-sdk/session-store-runtime.test.ts",
      "src/index.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "The September 30, 2026 approved cutoff in 1783c5fd6fc5b03d2b376ba7cbbab4461940207e retired the beta.5 session-store bridge, its option types, and package-root loadSessionStore/saveSessionStore aliases ahead of the former October 12 window. Plugins must use scoped row APIs and identity-backed transcript APIs; the session-store-runtime subpath and resolveStorePath remain available.",
  },
  {
    code: "transcript-lock-sync-message-preparation",
    ...DEPRECATED_SESSION_COMPAT,
    introduced: "2026-09-08",
    deprecated: "2026-10-05",
    warningStarts: "2026-10-08",
    replacement:
      "Use withSessionTranscriptWrite (or withCodexSessionTranscriptMirrorWrite) with preparation.prepareMessage and preparation.source. Legacy lock and opaque callback forms retain durable transaction ordering until removal after stable deprecation and a compatibility period; incognito targets reject them with migration guidance.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-locked-transcript-preparation",
    surfaces: [
      "SessionTranscriptWriteLockContext.appendMessage.prepareMessageAfterIdempotencyCheck",
      "CodexSessionTranscriptMirrorWriteLockContext.appendMessageWithMessageSequence.prepareMessageAfterIdempotencyCheck",
      "SessionTranscriptWriteLockContext.appendMessage.beforeFreshMessageCommit",
      "CodexSessionTranscriptMirrorWriteLockContext.appendMessageWithMessageSequence.beforeFreshMessageCommit",
      "withSessionTranscriptWriteLock",
      "withCodexSessionTranscriptMirrorWriteLock",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations; one runtime warning per plugin for legacy transcript callbacks/locks; incognito targets receive an actionable replacement error",
    ],
    tests: [
      "src/plugin-sdk/session-transcript-lock.native.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Transcript writes have an optimistic, actor-compatible preparation contract. Legacy durable callbacks/locks retain transaction ordering; incognito callers migrate to preparation options. Stored data and update behavior are unchanged, and ordinary incognito routing stays host-owned.",
  },
  {
    code: "session-upstream-links-sync-persistence",
    ...DEPRECATED_SESSION_COMPAT,
    introduced: "2026-07-14",
    deprecated: "2026-10-05",
    warningStarts: "2026-10-05",
    replacement:
      "Await upsertSessionUpstreamLinkAsync and deleteSessionUpstreamLinkAsync from session-catalog. Official harnesses await the native initializer's linkAsync method. Retain the synchronous signatures and completion timing shipped in v2026.9.8 until removal after stable deprecation and a compatibility period.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-upstream-links",
    surfaces: [
      "openclaw/plugin-sdk/session-catalog.upsertSessionUpstreamLink",
      "openclaw/plugin-sdk/session-catalog.deleteSessionUpstreamLink",
      "openclaw/plugin-sdk/agent-harness-session-runtime.createNativeSessionInitializationOwner().prepare().link",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and one shared DEP_SESSION_PERSISTENCE warning per plugin and upstream-link capability family; unscoped consumers share one SDK-level warning",
    ],
    tests: [
      "src/plugin-sdk/session-catalog-upstream-compat.test.ts",
      "src/sessions/session-upstream-links.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Bundled session adoption and native initialization await upstream-link writes through the shared-state worker. Released synchronous SDK methods remain compatible until removal after stable deprecation and a compatibility period; schemas, stored data, retention, and update behavior are unchanged.",
  },
  {
    code: "session-observer-progress-sync-reads",
    ...DEPRECATED_SESSION_COMPAT,
    introduced: "2026-09-08",
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    replacement:
      "Await sessionObserver.handleEventAsync, getCompanionSnapshotAsync, and disposeAsync. Use reply_dispatch shouldSendToolSummariesAsync/shouldSendFullToolDetailsAsync and onVerboseProgressVisibilityAsync. Retain synchronous contracts until removal after stable deprecation and a compatibility period.",
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
    ...DEPRECATED_SESSION_COMPAT,
    introduced: "2026-10-05",
    deprecated: "2026-10-05",
    warningStarts: "2026-10-05",
    replacement:
      "Await readSessionUpdatedAtAsync, createChannelInboundEnvelopeBuilderAsync, or resolveInboundSessionEnvelopeContextAsync at each message's formatting boundary. Resolve routes through resolveAgentRoute and use dispatchInboundDirectDm. Retain the synchronous signatures and callback timing shipped in 2026.9.8 until removal after stable deprecation and a compatibility period.",
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
    ...DEPRECATED_SESSION_COMPAT,
    owner: "agent-runtime",
    introduced: "2026-10-04",
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    replacement:
      "Use onPreparedAgentRunStart with a required transcriptStart field, forwarding the complete notification and synchronous return value. Bundled runtimes prepare the facts asynchronously; retain the released onAgentRunStart callback and omitted-facts synchronous read until removal after stable deprecation and a compatibility period.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#reply-run-start-transcript-facts",
    surfaces: [
      "openclaw/plugin-sdk/reply-runtime.GetReplyOptions.onAgentRunStart",
      "PluginHookReplyDispatchContext.onAgentRunStart",
    ],
    diagnostics: [
      "TypeScript @deprecated annotation and one runtime DEP_SESSION_PERSISTENCE warning per plugin and callback family per process",
    ],
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
    ...DEPRECATED_SESSION_COMPAT,
    introduced: "2026-10-04",
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    replacement:
      "Await SessionManager.readSessionContextAsync for full-fidelity context consumption. The synchronous reader retains its shipped result until removal after stable deprecation and a compatibility period.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence",
    surfaces: ["SessionManager.readSessionContext"],
    diagnostics: [
      "TypeScript @deprecated annotation and one runtime DEP_SESSION_PERSISTENCE warning per plugin and capability family per process",
    ],
    tests: [
      "src/plugin-sdk/agent-sessions.context-compat.test.ts",
      "src/agents/sessions/session-manager-incognito.test.ts",
      "src/agents/sessions/session-manager-model-context-snapshot.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Plugins can await full-fidelity SessionManager context reads and asynchronous consumers. Owner and admission checks cover consumption; later transcript writes do not invalidate the captured snapshot. The synchronous reader remains available until removal after stable deprecation and a compatibility period. Storage and update behavior are unchanged.",
  },
  {
    code: "session-reset-freshness-sync-read",
    ...DEPRECATED_SESSION_COMPAT,
    introduced: "2026-10-05",
    deprecated: "2026-10-05",
    warningStarts: "2026-10-05",
    replacement:
      "Await runtime.channel.session.resolveEntryResetFreshnessAsync. The released synchronous resolveEntryResetFreshness method retains its parameters and result until removal after stable deprecation and a compatibility period.",
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
    ...DEPRECATED_SESSION_COMPAT,
    owner: "agent-runtime",
    introduced: "2026-05-30",
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    replacement:
      "Await runAgentEndSideEffectsAsync before releasing the turn lease. The released runAgentEndSideEffects helper retains its synchronous void result and scheduling behavior until removal after stable deprecation and a compatibility period.",
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
    ...REMOVED_SESSION_COMPAT,
    owner: "agent-runtime",
    introduced: "2026-09-22",
    deprecated: "2026-10-03",
    warningStarts: "2026-10-03",
    replacement:
      "Await prepareNativeSessionGenerationAuthority, resolveNativeSessionBindingWithAuthority, and reclaimNativeSessionGenerationWithAuthority with NativeSessionGenerationOperationsV2.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#native-session-generation-authority",
    surfaces: [
      "captureNativeSessionGenerationAuthority",
      "resolveNativeSessionBinding",
      "reclaimNativeSessionGeneration",
      "NativeSessionGenerationOperations",
    ],
    tests: [
      "src/agents/harness/native-session/binding-generation-authority.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Removes synchronous generation capture and the legacy mutation callback contracts first deprecated in stable v2026.10.1. Harnesses use worker-prepared authority and the V2 operations; live authority remains checked at the effect boundary.",
  },
  {
    code: "native-session-deletion-unbound-callbacks",
    ...DEPRECATED_SESSION_COMPAT,
    owner: "agent-runtime",
    introduced: "2026-08-26",
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    replacement:
      "Pass participants from createNativeSessionBindingLifecycleV2.withDeletion for reversible stored bindings or createNativeSessionCommitFinalizer for commit-only cleanup. Factory-produced participants and the existing harness hooks remain supported; direct unbound callbacks retain synchronous commit and rollback until removal after stable deprecation and a compatibility period.",
    docsPath:
      "/plugins/sdk-migration/how-to-migrate#replace-unbound-native-session-deletion-callbacks",
    surfaces: [
      "AgentHarnessSessionDeletionMutation unbound commit/rollback callbacks",
      "AgentHarness.withSessionDeletion unbound mutation argument",
      "AgentHarness.withSessionContextReset unbound mutation argument",
    ],
    diagnostics: [
      "TypeScript contract documentation and one shared DEP_SESSION_PERSISTENCE warning per plugin and native-session-deletion family per process, emitted only for unbound callbacks",
    ],
    tests: [
      "src/config/sessions/session-native-binding.reclamation.test.ts",
      "src/config/sessions/session-native-binding.settlement.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Session replacement can settle typed native bindings through the existing worker transaction. Unbound synchronous harness callbacks are deprecated with supported factory replacements; stored data and update behavior are unchanged.",
  },
  {
    code: "session-manager-sync-persistence",
    ...REMOVED_SESSION_COMPAT,
    introduced: "2026-10-01",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    replacement:
      "Await the matching Async-suffixed SessionManager method, including the returned rewrite commit.",
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
    tests: [
      "src/plugins/compat/registry.test.ts",
      "src/agents/sessions/session-manager-async-entries.test.ts",
      "src/agents/sessions/session-manager-async-message.test.ts",
      "src/agents/sessions/session-manager-maintenance-async.test.ts",
    ],
    releaseNote:
      "Removes synchronous SessionManager persistence adapters. Open, bounded opens, target replacement, and reload were first deprecated in stable v2026.9.6; appendMessageToTranscript in v2026.9.7; remaining transcript mutations and model-context opening in v2026.10.1. Stored data and update behavior are unchanged.",
  },
  {
    code: "extension-session-sync-persistence",
    ...REMOVED_SESSION_COMPAT,
    introduced: "2026-10-01",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    replacement:
      "Await ExtensionAPI.appendEntryAsync, setSessionNameAsync, and setLabelAsync, and AgentSession.setSessionNameAsync. Supply ExtensionActionsV2 and ExtensionRuntimeV2 through bindCoreAsync.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-extension-session-changes",
    surfaces: [
      "ExtensionAPI.appendEntry",
      "ExtensionAPI.setSessionName",
      "ExtensionAPI.setLabel",
      "AgentSession.setSessionName",
    ],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "src/agents/sessions/sdk.metadata-admission.test.ts",
    ],
    releaseNote:
      "Removes synchronous extension entries, session names, and labels first deprecated in stable v2026.10.1. Extensions await the existing persistence methods; stored data and update behavior are unchanged.",
  },
  {
    code: "provider-replay-sync-persistence",
    ...REMOVED_SESSION_COMPAT,
    owner: "provider",
    introduced: "2026-10-01",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    replacement:
      "Use ProviderPlugin.sanitizeReplayHistoryAsync with ProviderSanitizeReplayHistoryContextV2 and await ProviderReplaySessionStateV2.appendCustomEntryAsync; use sanitizeGoogleGeminiReplayHistoryAsync for the shared Gemini implementation.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-provider-replay-metadata",
    surfaces: [
      "ProviderPlugin.sanitizeReplayHistory",
      "ProviderReplaySessionState.appendCustomEntry",
      "sanitizeGoogleGeminiReplayHistory",
      "openclaw/plugin-sdk/core.ProviderReplaySessionState",
      "openclaw/plugin-sdk/core.ProviderSanitizeReplayHistoryContext",
      "openclaw/plugin-sdk/plugin-entry.ProviderReplaySessionState",
      "openclaw/plugin-sdk/plugin-entry.ProviderSanitizeReplayHistoryContext",
    ],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "src/plugins/provider-replay-helpers.test.ts",
      "src/plugins/provider-runtime.test.ts",
      "src/plugin-sdk/provider-model-shared.test.ts",
    ],
    releaseNote:
      "Removes legacy provider replay hooks and context types first deprecated in stable v2026.10.1. The synchronous Gemini helper was first deprecated in stable v2026.5.12 in favor of provider-local replay hooks; its async replacement shipped by v2026.10.1. Await replay metadata persistence before using the resulting history.",
  },
  {
    code: "agent-execution-preparation-released-signature",
    status: "active",
    owner: "sdk",
    introduced: "2026-10-06",
    removalGate: "after-stable-deprecation",
    replacement:
      "Keep the execution input shapes shipped in v2026.9.9 and v2026.10.1-beta.1 by openOpenClawAgentSqliteWorkerStore, including the beta capturePreparedGenerationClaim method for parameter-derived types. Private native-adoption capabilities are not plugin requirements. Host schema readmission uses an optional third argument; existing callers and two-argument prepare implementations remain supported without migration or deprecation.",
    docsPath:
      "/plugins/sdk-migration/compatibility-policy#agent-execution-preparation-compatibility",
    surfaces: [
      "openclaw/plugin-sdk/sqlite-runtime.openOpenClawAgentSqliteWorkerStore publicationSource.execution",
      "openclaw/plugin-sdk/sqlite-runtime.openOpenClawAgentSqliteWorkerStore publicationSource.execution.prepare",
    ],
    diagnostics: ["SDK type assertions and compatibility documentation; no runtime warnings"],
    tests: [
      "src/plugin-sdk/sqlite-runtime.preparation-compat.test.ts",
      "src/state/openclaw-agent-execution.creation-witness.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Agent execution reuses completed native preparation while explicit host admission refreshes schema proof. Released execution objects do not require private host capabilities; preparation calls and implementations retain their Promise contract. Schemas, stored data, and update behavior are unchanged.",
  },
  {
    code: "acp-session-sync-read",
    ...REMOVED_SESSION_COMPAT,
    introduced: "2026-09-04",
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    replacement:
      "Await readAcpSessionEntryAsync and AcpSessionManager.resolveSessionAsync. Custom managers inject loadSessionEntryAsync; the released async parameter and result contracts remain supported.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#acp-metadata-binding-compatibility",
    surfaces: [
      "openclaw/plugin-sdk/acp-runtime.readAcpSessionEntry",
      "AcpSessionManager.resolveSession",
      "AcpSessionManagerDeps.loadSessionEntry",
    ],
    tests: ["src/plugin-sdk/acp-runtime.test.ts", "src/acp/runtime/session-meta-read.test.ts"],
    releaseNote:
      "Removes the synchronous ACP reader and manager resolver first deprecated in stable v2026.9.7, together with the resolver-only loadSessionEntry injection. The existing worker supplies metadata; schemas, stored data, and update behavior are unchanged.",
  },
  {
    code: "acp-session-metadata-released-signatures",
    status: "active",
    owner: "sdk",
    introduced: "2026-10-04",
    removalGate: "after-stable-deprecation",
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
    removalGate: "after-stable-deprecation",
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
    ...DEPRECATED_SESSION_COMPAT,
    introduced: "2026-09-08",
    deprecated: "2026-10-05",
    warningStarts: "2026-10-08",
    replacement:
      "Use preparation.prepareMessage and preparation.source with appendSessionTranscriptMessageByIdentityStrict or appendSessionTranscriptMessageByIdentity. Legacy opaque callbacks retain durable transaction ordering until removal after stable deprecation and a compatibility period; incognito targets reject them with migration guidance.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-strict-transcript-message-preparation",
    surfaces: [
      "appendSessionTranscriptMessageByIdentityStrict.prepareMessageAfterIdempotencyCheck",
      "appendSessionTranscriptMessageByIdentityStrict.beforeFreshMessageCommit",
      "appendSessionTranscriptMessageByIdentity.prepareMessageAfterIdempotencyCheck",
      "appendSessionTranscriptMessageByIdentity.beforeFreshMessageCommit",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations; one runtime warning per plugin shared with legacy transcript locks; incognito targets receive an actionable replacement error",
    ],
    tests: [
      "src/plugin-sdk/session-transcript-runtime.worker-preparation.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Strict and ordinary transcript appends accept prepared source authority and awaited message preparation. Legacy durable callbacks remain compatible until removal after stable deprecation and a compatibility period; stored data and update behavior are unchanged.",
  },
] as const satisfies readonly PluginCompatRecord[];
