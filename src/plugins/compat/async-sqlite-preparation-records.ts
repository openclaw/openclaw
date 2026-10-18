import type { PluginCompatRecord } from "./types.js";

// Dates mark this registry/diagnostic preparation, not a shipped stable removal window.
const PREPARATION = {
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-13",
  deprecated: "2026-10-13",
  warningStarts: "2026-10-13",
  removalGate: "stable-deprecation-period",
  diagnostics: [
    "TypeScript @deprecated annotations and actionable once-per-plugin-and-capability-family warnings per process on legacy use",
  ],
} as const;

export const ASYNC_SQLITE_PREPARATION_COMPAT_RECORDS = [
  {
    ...PREPARATION,
    code: "session-store-sync-readers",
    replacement:
      "Await getSessionEntryAsync, getConversationSessionAsync, readAmbientTranscriptWatermarkAsync, and loadTranscriptEvents. Synchronous readers retain their results during the stable deprecation period. Current entry lookup is not a substitute for historical transcript-key resolution.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-and-transcript-readers",
    surfaces: [
      "openclaw/plugin-sdk/session-store-runtime.getSessionEntry",
      "openclaw/plugin-sdk/session-store-runtime.getConversationSession",
      "openclaw/plugin-sdk/session-store-runtime.readAmbientTranscriptWatermark",
      "openclaw/plugin-sdk/session-store-runtime.loadTranscriptEventsSync",
      "api.runtime.agent.session.getSessionEntry",
      "api.runtime.agent.session.getConversationSession",
    ],
    tests: [
      "src/plugin-sdk/session-store-runtime.async.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
  },
  {
    ...PREPARATION,
    code: "transcript-session-key-sync-resolution",
    replacement:
      "Await resolveTranscriptSessionKeyBySessionIdAsync from session-store-runtime. It preserves exact historical session-window resolution, including session IDs no longer selected by the current entry.",
    docsPath: "/plugins/sdk-migration/async-transcript-and-tts",
    surfaces: ["openclaw/plugin-sdk/session-store-runtime.resolveTranscriptSessionKeyBySessionId"],
    tests: [
      "src/plugin-sdk/session-store-runtime.async.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
  },
  {
    ...PREPARATION,
    code: "pending-input-sync-completion",
    replacement:
      "Await SessionPendingInputReceipt.completeAsync or UserTurnTranscriptRecorder.completeProcessingAsync before publishing completion. Await waitForPendingInputSettlement when supplied before releasing session admission. Older host recorders without an async companion retain their named compatibility adapter; do not retry async failures through it.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence",
    surfaces: [
      "SessionPendingInputReceipt.complete",
      "UserTurnTranscriptRecorder.completeProcessing",
    ],
    tests: [
      "src/config/sessions/session-pending-input-operations.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
  },
  {
    ...PREPARATION,
    code: "session-catalog-sync-preparation",
    replacement:
      "Await readSessionTranscriptCatalogTitleAsync, prepareSessionCatalogSourceActorProjector, and prepareSessionCatalogGitHubLinker from session-transcript-runtime. Project the prepared facts synchronously and retain current disclosure authority at publication.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#prepare-session-catalog-identities",
    surfaces: [
      "openclaw/plugin-sdk/session-transcript-runtime.readSessionTranscriptCatalogTitle",
      "openclaw/plugin-sdk/session-transcript-runtime.createSessionCatalogSourceActorProjector",
      "openclaw/plugin-sdk/session-transcript-runtime.createSessionCatalogGitHubLinker",
    ],
    tests: ["src/gateway/session-catalog-identity.test.ts", "src/plugins/compat/registry.test.ts"],
  },
  {
    ...PREPARATION,
    code: "channel-policy-sync-preparation",
    replacement:
      "Await resolveCommandAuthorizationAsync, resolveStoredModelOverrideAsync, resolveCommandArgMenuAsync, inspectConversationBindingAsync, and loadExecApprovalsReadOnlyAsync. Prepared results never replace live authorization at command execution or external side effects.",
    docsPath:
      "/plugins/sdk-migration/how-to-migrate#migrate-inspection-authorization-and-approval-factories",
    surfaces: [
      "openclaw/plugin-sdk/command-auth-native.resolveCommandAuthorization",
      "openclaw/plugin-sdk/command-auth-native.resolveStoredModelOverride",
      "openclaw/plugin-sdk/command-auth-native.resolveCommandArgMenu",
      "openclaw/plugin-sdk/conversation-binding-inspection-runtime.inspectConversationBinding",
      "openclaw/plugin-sdk/exec-approvals-runtime.loadExecApprovals",
    ],
    tests: ["src/plugin-sdk/command-auth-native.test.ts", "src/plugins/compat/registry.test.ts"],
  },
  {
    ...PREPARATION,
    code: "approval-routing-sync-preparation",
    replacement:
      "Use the Async-suffixed approval factories and resolvers, then await their returned eligibility and routing callbacks. Reuse resolveApprovalRequestSessionDeliveryAsync facts for one route decision. Factories remain synchronous; Async names describe their awaited callbacks. Keep live approval and delivery authority at the effect boundary.",
    docsPath:
      "/plugins/sdk-migration/how-to-migrate#migrate-inspection-authorization-and-approval-factories",
    surfaces: [
      "openclaw/plugin-sdk/approval-delivery-runtime.createApproverRestrictedNativeApprovalCapability",
      "openclaw/plugin-sdk/approval-handler-runtime.createChannelApprovalNativeRuntimeAdapter",
      "openclaw/plugin-sdk/approval-handler-adapter-runtime.createLazyChannelApprovalNativeRuntimeAdapter",
      "openclaw/plugin-sdk/approval-delivery-runtime.createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes",
      "openclaw/plugin-sdk/approval-native-runtime.createNativeApprovalChannelRouteGates",
      "openclaw/plugin-sdk/approval-native-runtime.createChannelNativeOriginTargetResolver",
      "openclaw/plugin-sdk/approval-client-runtime.createChannelExecApprovalProfile",
      "openclaw/plugin-sdk/approval-native-runtime.createChannelApproverDmTargetResolver",
      "openclaw/plugin-sdk/approval-native-runtime.createNativeApprovalForwardingFallbackSuppressor",
      "openclaw/plugin-sdk/approval-runtime.resolveExecApprovalSessionTarget",
      "openclaw/plugin-sdk/approval-runtime.resolveApprovalRequestSessionTarget",
      "openclaw/plugin-sdk/approval-runtime.resolveApprovalRequestOriginTarget",
      "openclaw/plugin-sdk/approval-native-runtime.resolveApprovalRequestAccountId",
      "openclaw/plugin-sdk/approval-native-runtime.resolveApprovalRequestChannelAccountId",
      "openclaw/plugin-sdk/approval-runtime.doesApprovalRequestMatchChannelAccount",
      "openclaw/plugin-sdk/approval-native-runtime.doesApprovalRequestSelectChannelAccount",
    ],
    tests: [
      "src/plugin-sdk/approval-native-helpers.test.ts",
      "src/plugin-sdk/approval-delivery-helpers.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
  },
  {
    ...PREPARATION,
    code: "debug-proxy-sync-capture",
    replacement:
      "Acquire acquireDebugProxyCaptureStoreAsync, await store operations, and await lease.release in finally. Use createDebugProxyCaptureReaderAsync and await reads. Use initializeDebugProxyCaptureAsync, captureHttpExchangeAsync, captureWsEventAsync, and finalizeDebugProxyCaptureAsync, including the context captureWsEventAsync companion. Do not fire and forget persistence or fall back after an async failure.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-debug-proxy-capture",
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
      "DebugProxyCaptureContext.captureWsEvent",
    ],
    tests: [
      "src/proxy-capture/store.async.test.ts",
      "src/proxy-capture/runtime.lifecycle.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
  },
] as const satisfies readonly PluginCompatRecord[];
