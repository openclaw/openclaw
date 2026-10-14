import type { PluginCompatRecord } from "./types.js";

export const BINDING_PERSISTENCE_COMPAT_RECORDS = [
  {
    code: "conversation-binding-sync-persistence",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-09-08",
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
    tests: [
      "src/plugin-sdk/state-binding.released-compat.test.ts",
      "src/infra/outbound/session-binding-service.async-read.test.ts",
      "src/infra/outbound/current-conversation-bindings.worker.test.ts",
      "src/infra/outbound/account-scoped-conversation-bindings.test.ts",
    ],
    releaseNote:
      "Bundled conversation bindings await worker-owned mutations and expiry reads. Released synchronous adapters remain compatible; storage formats, retention, and update behavior are unchanged.",
  },
  {
    code: "native-session-binding-sync-persistence",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-09-08",
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
    tests: [
      "extensions/codex/harness.test.ts",
      "src/agents/embedded-agent-runner/run/model-setup.ownership.test.ts",
      "src/gateway/session-row-projection.worker-read.test.ts",
    ],
    releaseNote:
      "Native harness binding preparation and ordinary durable settlement use workers. Host-selected initialization, incognito, and mixed legacy deletion transactions retain their explicit native atomic settlement; no schema or update migration is required.",
  },
  {
    code: "approval-event-sync-publication",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-09-08",
    deprecated: "2026-10-10",
    warningStarts: "2026-10-10",
    removeAfter: "2026-12-31",
    replacement:
      "Await approvalEvents.publishRequestedAsync. The legacy publisher retains synchronous delivery counts for synchronous subscribers and refuses async eligibility before delivery; removed in the first January 2027 stable release after the final compatibility day, 2026-12-31.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#await-gateway-approval-publication",
    surfaces: ["GatewayRequestHandlerOptions.context.approvalEvents.publishRequested"],
    diagnostics: ["TypeScript @deprecated annotation and the shared capability-family warning"],
    tests: [
      "src/gateway/server-instance-runtime.test.ts",
      "src/plugin-sdk/state-binding.released-compat.test.ts",
    ],
    releaseNote:
      "Gateway approval publication awaits native eligibility while retaining the released synchronous publisher type and old publisher objects.",
  },
] as const satisfies readonly PluginCompatRecord[];
