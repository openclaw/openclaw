import { REPLY_TOOL_AUTHORITY_COMPAT_RECORD } from "./reply-tool-authority-record.js";
import { TRANSCRIPT_STATS_COMPAT_RECORD } from "./transcript-stats-record.js";
import type { PluginCompatRecord } from "./types.js";

const DEPRECATED_SESSION_COMPAT = {
  status: "deprecated",
  owner: "sdk",
  removeAfter: "2026-12-31",
  diagnostics: [
    "TypeScript @deprecated annotations and migration documentation; bounded capability-family warnings on legacy preparation",
  ],
} as const;

export const SESSION_PERSISTENCE_COMPAT_RECORDS = [
  REPLY_TOOL_AUTHORITY_COMPAT_RECORD,
  TRANSCRIPT_STATS_COMPAT_RECORD,
  {
    code: "session-store-sync-listing",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    replacement:
      "Await listSessionEntriesAsync with an explicit agentId for read-only metadata; use getSessionEntryAsync for complete entries. Retain final deletion and disclosure authority at the effect boundary. The synchronous listing remains compatible through 2026-12-31.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-metadata-listings",
    surfaces: [
      "openclaw/plugin-sdk/session-store-runtime.listSessionEntries",
      "api.runtime.agent.session.listSessionEntries",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and one shared DEP_PLUGIN_SDK warning per plugin and session-store family per process on legacy use",
    ],
  },
  {
    code: "github-publication-native-callbacks",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-09",
    warningStarts: "2026-10-09",
    replacement:
      "Use requestForSessionV2 and requestForClaimV2 with the host-provided GitHubPublicationRequesterV2, and requestPersonalForSessionV2 and confirmPersonalV2 with PersonalGitHubSessionActionV2. Await deferClaimPreparationAsync, deferOrphanedRequestsAsync, listUnreportedResultsAsync, markReportedAsync, readAsync, and personalStatusAsync. Legacy publication methods retain their signatures but fail at invocation. On githubOAuthService, await cancelAuthorizationAsync and retireProfileAsync; on its personal service, await cancelAuthorizationAsync and disconnectAsync. These OAuth compatibility methods retain synchronous completion. Deprecated signatures will be removed in the first January 2027 stable release after the final compatibility day, 2026-12-31.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-github-publication-operations",
    surfaces: [
      "GatewayRequestHandlerOptions.context.githubPublicationService.requestForSession",
      "GatewayRequestHandlerOptions.context.githubPublicationService.requestForClaim",
      "GatewayRequestHandlerOptions.context.githubPublicationService.requestPersonalForSession",
      "GatewayRequestHandlerOptions.context.githubPublicationService.confirmPersonal",
      "GatewayRequestHandlerOptions.context.githubPublicationService.deferClaimPreparation",
      "GatewayRequestHandlerOptions.context.githubPublicationService.deferOrphanedRequests",
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
  },
  {
    code: "session-store-opaque-mutations",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-09",
    warningStarts: "2026-10-09",
    replacement:
      "Use prepareSessionEntryPatch for host preparation followed by an exact-snapshot conditional commit, applySessionEntryPatch for data-only patches, and updateLastRouteWithAuthority for guarded route updates. Legacy opaque transaction guards retain their ordering and will be removed in the first January 2027 stable release after the final compatibility day, 2026-12-31.",
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
  },
  {
    code: "codex-transcript-sync-validation",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-06",
    warningStarts: "2026-10-06",
    replacement:
      "Await readCodexSessionContextProjection for retained worker projection and final validation. Keep the released synchronous validators through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major. readCodexSessionContext remains a supported synchronous worker reader with its released three-argument generic result contract.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence",
    surfaces: [
      "openclaw/plugin-sdk/codex-session-transcript-runtime.validateCodexSessionTranscriptReadAdmission",
      "openclaw/plugin-sdk/codex-session-transcript-runtime.validateCodexSessionTranscriptContextVersion",
    ],
  },
  {
    code: "deprecated-session-store-beta5-api",
    status: "removed",
    removeAfter: "2026-09-30",
    owner: "sdk",
    deprecated: "2026-07-12",
    warningStarts: "2026-07-12",
    replacement:
      "Use `getSessionEntryAsync(...)` and `listSessionEntriesAsync(...)` for reads; `prepareSessionEntryPatch(...)`, `applySessionEntryPatch(...)`, `upsertSessionEntry(...)`, and `deleteSessionEntry(...)` for row mutations; and session identity with `session-transcript-runtime` for active transcripts. The supported-plugin cutoff excludes v2026.7.1-beta.5 and other packages importing the retired bridge.",
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
  },
  {
    code: "transcript-lock-sync-message-preparation",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-05",
    warningStarts: "2026-10-08",
    replacement:
      "Use withSessionTranscriptWrite (or withCodexSessionTranscriptMirrorWrite) with preparation.prepareMessage and preparation.source. Legacy lock and opaque callback forms retain durable transaction ordering through 2026-12-31; incognito targets reject them with migration guidance.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-locked-transcript-preparation",
    surfaces: [
      "SessionTranscriptWriteLockContext.appendMessage.prepareMessageAfterIdempotencyCheck",
      "CodexSessionTranscriptMirrorWriteLockContext.appendMessageWithMessageSequence.prepareMessageAfterIdempotencyCheck",
      "SessionTranscriptWriteLockContext.appendMessage.beforeFreshMessageCommit",
      "CodexSessionTranscriptMirrorWriteLockContext.appendMessageWithMessageSequence.beforeFreshMessageCommit",
      "openclaw/plugin-sdk/session-transcript-runtime.withSessionTranscriptWriteLock",
      "openclaw/plugin-sdk/codex-session-transcript-runtime.withCodexSessionTranscriptMirrorWriteLock",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations; one runtime warning per plugin for legacy transcript callbacks/locks; incognito targets receive an actionable replacement error",
    ],
  },
  {
    code: "session-upstream-links-sync-persistence",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-05",
    warningStarts: "2026-10-05",
    replacement:
      "Await upsertSessionUpstreamLinkAsync and deleteSessionUpstreamLinkAsync from session-catalog. Official harnesses await the native initializer's linkAsync method. Retain the synchronous signatures and completion timing shipped in v2026.9.8 through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-upstream-links",
    surfaces: [
      "openclaw/plugin-sdk/session-catalog.upsertSessionUpstreamLink",
      "openclaw/plugin-sdk/session-catalog.deleteSessionUpstreamLink",
      "openclaw/plugin-sdk/agent-harness-session-runtime.createNativeSessionInitializationOwner().prepare().link",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and one shared DEP_SESSION_PERSISTENCE warning per plugin and upstream-link capability family; unscoped consumers share one SDK-level warning",
    ],
  },
  {
    code: "session-observer-progress-sync-reads",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    replacement:
      "Await sessionObserver.handleEventAsync, getCompanionSnapshotAsync, and disposeAsync. Use reply_dispatch shouldSendToolSummariesAsync/shouldSendFullToolDetailsAsync and onVerboseProgressVisibilityAsync. Retain synchronous contracts through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
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
  },
  {
    code: "channel-inbound-sync-envelope-timestamps",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-05",
    warningStarts: "2026-10-05",
    replacement:
      "Await readSessionUpdatedAtAsync, createChannelInboundEnvelopeBuilderAsync, or resolveInboundSessionEnvelopeContextAsync at each message's formatting boundary. Resolve routes through resolveAgentRoute and use dispatchInboundDirectDm. Retain the synchronous signatures and callback timing shipped in 2026.9.8 through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
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
  },
  {
    code: "reply-run-start-unprepared-transcript",
    ...DEPRECATED_SESSION_COMPAT,
    owner: "agent-runtime",
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    replacement:
      "Use onPreparedAgentRunStart with a required transcriptStart field, forwarding the complete notification and synchronous return value. Bundled runtimes prepare the facts asynchronously; retain the released onAgentRunStart callback and omitted-facts synchronous read through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#reply-run-start-transcript-facts",
    surfaces: [
      "openclaw/plugin-sdk/reply-runtime.GetReplyOptions.onAgentRunStart",
      "PluginHookReplyDispatchContext.onAgentRunStart",
    ],
    diagnostics: [
      "TypeScript @deprecated annotation and one runtime DEP_SESSION_PERSISTENCE warning per plugin and callback family per process",
    ],
  },
  {
    code: "session-manager-sync-context-read",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    replacement:
      "Await SessionManager.readSessionContextAsync for full-fidelity context consumption. The synchronous reader retains its shipped result through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence",
    surfaces: ["SessionManager.readSessionContext"],
    diagnostics: [
      "TypeScript @deprecated annotation and one runtime DEP_SESSION_PERSISTENCE warning per plugin and capability family per process",
    ],
  },
  {
    code: "session-reset-freshness-sync-read",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-05",
    warningStarts: "2026-10-05",
    replacement:
      "Await runtime.channel.session.resolveEntryResetFreshnessAsync. The released synchronous resolveEntryResetFreshness method retains its parameters and result through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-migration#session-reset-freshness",
    surfaces: ["api.runtime.channel.session.resolveEntryResetFreshness"],
    diagnostics: [
      "TypeScript @deprecated annotation and migration documentation; bounded capability-family warnings on legacy preparation",
    ],
  },
  {
    code: "agent-end-sync-side-effects",
    ...DEPRECATED_SESSION_COMPAT,
    owner: "agent-runtime",
    deprecated: "2026-10-04",
    warningStarts: "2026-10-04",
    replacement:
      "Await runAgentEndSideEffectsAsync before releasing the turn lease. The released runAgentEndSideEffects helper retains its synchronous void result and scheduling behavior through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-agent-harness/attempt-runtime#agent-end-side-effects",
    surfaces: ["openclaw/plugin-sdk/agent-harness-runtime.runAgentEndSideEffects"],
    diagnostics: [
      "TypeScript @deprecated annotation and migration documentation; bounded capability-family warnings on legacy preparation",
    ],
  },
  {
    code: "native-session-generation-sync-authority",
    ...DEPRECATED_SESSION_COMPAT,
    owner: "agent-runtime",
    deprecated: "2026-10-03",
    warningStarts: "2026-10-03",
    replacement:
      "Await retainNativeSessionGenerationAuthority, resolvePreparedNativeSessionBinding, and reclaimNativeSessionGenerationWithAuthority. Release prepared captures after terminal cleanup. Released synchronous capture and two-argument mutation callbacks remain deprecated while published official harness readers migrate.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#native-session-generation-authority",
    surfaces: [
      "openclaw/plugin-sdk/agent-harness-session-runtime.captureNativeSessionGenerationAuthority",
      "openclaw/plugin-sdk/agent-harness-session-runtime.resolveNativeSessionBinding",
      "openclaw/plugin-sdk/agent-harness-session-runtime.reclaimNativeSessionGeneration",
      "openclaw/plugin-sdk/agent-harness-session-runtime.NativeSessionGenerationOperations",
    ],
  },
  {
    code: "native-session-deletion-unbound-callbacks",
    ...DEPRECATED_SESSION_COMPAT,
    owner: "agent-runtime",
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    replacement:
      "Pass participants from createNativeSessionBindingLifecycleV2.withDeletion for reversible stored bindings or createNativeSessionCommitFinalizer for commit-only cleanup. Factory-produced participants and the existing harness hooks remain supported; direct unbound callbacks retain synchronous commit and rollback through 2026-12-31.",
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
  },
  {
    code: "session-manager-sync-persistence",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    replacement:
      "Await the matching Async-suffixed SessionManager method, including the returned rewrite commit. For resolveCurrentTurnEntryId with includeOmittedCustomMessages, await openAsync and traverse the complete view without that option. Shipped synchronous adapters remain compatible during their deprecation period and will be removed in the first January 2027 stable release after the final compatibility day, 2026-12-31.",
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
      "SessionManager.resolveCurrentTurnEntryId.includeOmittedCustomMessages",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations naming awaited twins",
      "one runtime DEP_SESSION_PERSISTENCE warning per plugin and capability family per process",
    ],
  },
  {
    code: "extension-session-sync-persistence",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    replacement:
      "Await ExtensionAPI.appendEntryAsync, setSessionNameAsync, and setLabelAsync, and AgentSession.setSessionNameAsync. Existing synchronous third-party methods retain their void return contract through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-extension-session-changes",
    surfaces: [
      "ExtensionAPI.appendEntry",
      "ExtensionAPI.setSessionName",
      "ExtensionAPI.setLabel",
      "AgentSession.setSessionName",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations, migration guide, and shared once-per-plugin-and-family DEP_SESSION_PERSISTENCE warning",
    ],
  },
  {
    code: "provider-replay-sync-persistence",
    ...DEPRECATED_SESSION_COMPAT,
    owner: "provider",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    replacement:
      "Use ProviderPlugin.sanitizeReplayHistoryAsync with ProviderSanitizeReplayHistoryContextV2 and await ProviderReplaySessionStateV2.appendCustomEntryAsync; use sanitizeGoogleGeminiReplayHistoryAsync for the shared Gemini implementation. Retain legacy third-party contexts and hooks through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-provider-replay-metadata",
    surfaces: [
      "ProviderPlugin.sanitizeReplayHistory",
      "ProviderReplaySessionState.appendCustomEntry",
      "openclaw/plugin-sdk/provider-model-shared.sanitizeGoogleGeminiReplayHistory",
      "ProviderSanitizeReplayHistoryContext",
      "ProviderReplaySessionState",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations, versioned migration guide, and shared once-per-plugin-and-family DEP_SESSION_PERSISTENCE warning",
    ],
  },
  {
    code: "agent-execution-preparation-released-signature",
    status: "active",
    owner: "sdk",
    replacement:
      "Keep the execution input shapes shipped in v2026.9.9 and v2026.10.1-beta.1 by openOpenClawAgentSqliteWorkerStore, including the beta capturePreparedGenerationClaim method for parameter-derived types. Private native-adoption capabilities are not plugin requirements. The released two-argument prepare contract remains supported without migration or deprecation; host admission reuses the native owner’s published schema facts.",
    docsPath:
      "/plugins/sdk-migration/compatibility-policy#agent-execution-preparation-compatibility",
    surfaces: [
      "openclaw/plugin-sdk/sqlite-runtime.openOpenClawAgentSqliteWorkerStore publicationSource.execution",
      "openclaw/plugin-sdk/sqlite-runtime.openOpenClawAgentSqliteWorkerStore publicationSource.execution.prepare",
    ],
    diagnostics: ["SDK type assertions and compatibility documentation; no runtime warnings"],
  },
  {
    code: "acp-session-sync-read",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-11",
    warningStarts: "2026-10-11",
    replacement:
      "Await readAcpSessionEntryAsync. Bundled consumers use the existing worker-backed reader; the released synchronous reader keeps its result contract through 2026-12-31; removal ships in the first January 2027 stable release.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#acp-metadata-binding-compatibility",
    surfaces: [
      "openclaw/plugin-sdk/acp-runtime.readAcpSessionEntry",
      "AcpSessionManager.resolveSession",
    ],
    diagnostics: [
      "TypeScript @deprecated annotation and one shared DEP_PLUGIN_SDK warning per plugin and ACP-session family per process on legacy use",
    ],
  },
  {
    code: "acp-session-metadata-released-signatures",
    status: "active",
    owner: "sdk",
    replacement:
      "Keep the released one-argument ACP reader and manager read/write injection signatures. Internal actor bindings are not plugin arguments; actor activation must preserve these callable contracts. The APIs remain supported and are not deprecated.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#acp-metadata-binding-compatibility",
    surfaces: [
      "openclaw/plugin-sdk/acp-runtime.readAcpSessionEntryAsync",
      "AcpSessionManagerDeps.loadSessionEntryAsync",
      "AcpSessionManagerDeps.upsertSessionMeta",
    ],
    diagnostics: ["SDK type assertions and compatibility documentation; no runtime warnings"],
  },
  {
    code: "memory-session-released-signatures",
    status: "active",
    owner: "sdk",
    replacement:
      "Keep the released Memory entry, corpus, and reset-recall reader signatures. Internal actor sources are not plugin arguments; actor activation must preserve the existing Promise results and synchronous message observers. These APIs remain supported and are not deprecated.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#memory-session-binding-compatibility",
    surfaces: [
      "openclaw/plugin-sdk/memory-core-host-engine-sessions.buildSessionEntry",
      "openclaw/plugin-sdk/memory-core-host-engine-sessions.listSessionTranscriptCorpusEntriesForAgent",
      "openclaw/plugin-sdk/memory-core-host-engine-sessions.readSessionResetRecallCutoff",
    ],
    diagnostics: ["SDK type assertions and compatibility documentation; no runtime warnings"],
  },
  {
    code: "transcript-strict-sync-message-preparation",
    ...DEPRECATED_SESSION_COMPAT,
    deprecated: "2026-10-05",
    warningStarts: "2026-10-08",
    replacement:
      "Use preparation.prepareMessage and preparation.source with appendSessionTranscriptMessageByIdentityStrict or appendSessionTranscriptMessageByIdentity. Legacy opaque callbacks retain durable transaction ordering through 2026-12-31; incognito targets reject them with migration guidance.",
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
  },
] as const satisfies readonly PluginCompatRecord[];
