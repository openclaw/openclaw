import type { PluginCompatRecord } from "./types.js";

export const BINDING_PERSISTENCE_COMPAT_RECORDS = [
  {
    code: "conversation-binding-sync-persistence",
    status: "deprecated",
    owner: "sdk",
    deprecated: "2026-10-09",
    warningStarts: "2026-10-09",
    removeAfter: "2026-12-31",
    replacement:
      "Use createAccountScopedConversationBindingManagerV2, iMessage createIMessageConversationBindingManagerV2, registerSessionBindingAdapterV2, and awaited service list/resolve/touch methods. V2 adapters supply a coherent inspection snapshot with its current-source assertion. Legacy synchronous operations preserve completion and expiry semantics through 2026-12-31; removal ships in the first January 2027 stable release.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-plugin-state-and-conversation-bindings",
    surfaces: [
      "openclaw/plugin-sdk/thread-bindings-runtime.createAccountScopedConversationBindingManager",
      "@openclaw/imessage api.createIMessageConversationBindingManager",
      "AccountScopedConversationBindingManager.getByConversationId",
      "AccountScopedConversationBindingManager.listBySessionKey",
      "AccountScopedConversationBindingManager.bindConversation",
      "AccountScopedConversationBindingManager.touchConversation",
      "AccountScopedConversationBindingManager.unbindConversation",
      "AccountScopedConversationBindingManager.unbindBySessionKey",
      "SessionBindingAdapter.listBySession",
      "SessionBindingAdapter.inspectByConversation",
      "openclaw/plugin-sdk/conversation-runtime.registerSessionBindingAdapter",
      "SessionBindingService.listBySession",
      "SessionBindingService.resolveByConversation",
      "SessionBindingService.touch",
      "openclaw/plugin-sdk/session-binding-runtime.inspectSessionBindingByConversation",
      "openclaw/plugin-sdk/conversation-runtime.resolveRuntimeConversationBindingRoute",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and one shared runtime warning per plugin and capability family on legacy use",
    ],
  },
  {
    code: "native-session-binding-sync-persistence",
    status: "deprecated",
    owner: "sdk",
    deprecated: "2026-10-09",
    warningStarts: "2026-10-09",
    removeAfter: "2026-12-31",
    replacement:
      "Use createNativeSessionBindingLifecycleV2 and resolvePreparedNativeSessionBinding with the worker-backed binding store, and release the prepared capture after terminal cleanup. Implement AgentHarness.resolveSessionRuntimeOwnershipAsync for preparation. Released synchronous authority factories remain deprecated compatibility adapters.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-plugin-state-and-conversation-bindings",
    surfaces: [
      "openclaw/plugin-sdk/agent-harness-session-runtime.createNativeSessionBindingLifecycle",
      "openclaw/plugin-sdk/agent-harness-session-runtime.NativeSessionBindingStateStore",
      "openclaw/plugin-sdk/agent-harness-session-runtime.resolveNativeSessionBindingWithAuthority",
      "AgentHarness.resolveSessionRuntimeOwnership",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and the shared per-plugin capability-family warning budget",
    ],
  },
  {
    code: "approval-event-sync-publication",
    status: "deprecated",
    owner: "sdk",
    deprecated: "2026-10-10",
    warningStarts: "2026-10-10",
    removeAfter: "2026-12-31",
    replacement:
      "Await approvalEvents.publishRequestedAsync. The legacy publisher retains synchronous delivery counts for synchronous subscribers and refuses async eligibility before delivery; removed in the first January 2027 stable release after the final compatibility day, 2026-12-31.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-gateway-approval-publication",
    surfaces: ["GatewayRequestHandlerOptions.context.approvalEvents.publishRequested"],
    diagnostics: ["TypeScript @deprecated annotation and the shared capability-family warning"],
  },
] as const satisfies readonly PluginCompatRecord[];
