import { AGENT_HARNESS_COMPAT_RECORDS } from "./agent-harness-records.js";
import { AGENT_LIST_RUNTIME_PROJECTION_COMPAT_RECORDS } from "./agent-list-runtime-projection-records.js";
import { BINDING_PERSISTENCE_COMPAT_RECORDS } from "./binding-persistence-records.js";
import { CHANNEL_PAIRING_COMPAT_RECORD } from "./channel-pairing-record.js";
import { DEPRECATION_MARKING_COMPAT_RECORDS } from "./deprecation-marking.js";
import { MEDIA_LEGACY_PROJECTION_COMPAT_RECORD } from "./media-legacy-projection.js";
import { MENTION_INBOX_COMPAT_RECORD } from "./mention-inbox-record.js";
import { MODEL_ACCOUNT_CONNECT_COMPAT_RECORD } from "./model-account-connect-record.js";
import { NATIVE_EXEC_APPROVAL_COMPAT_RECORD } from "./native-exec-approval-record.js";
import { PLUGIN_SDK_REMOVED_EXPORT_RECORDS } from "./plugin-sdk-removed-export-records.js";
import {
  BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_RECORDS,
  PLUGIN_SDK_SUBPATH_RECORDS,
} from "./plugin-sdk-subpath-records.js";
import { PROGRESS_RECEIPT_HANDOFF_COMPAT_RECORD } from "./progress-receipt-handoff-record.js";
import { SESSION_PERSISTENCE_COMPAT_RECORDS } from "./session-persistence-records.js";
import { SKILL_COMMAND_DISCOVERY_COMPAT_RECORD } from "./skill-command-discovery-record.js";
import { SKILL_PROPOSAL_HOOKS_COMPAT_RECORD } from "./skill-proposal-hooks-record.js";
import { SQLITE_RUNTIME_COMPAT_RECORDS } from "./sqlite-runtime-records.js";
import { TTS_PREFERENCES_COMPAT_RECORD } from "./tts-preferences-record.js";
import type { PluginCompatRecord } from "./types.js";
import { WATCHED_SESSIONS_COMPAT_RECORD } from "./watched-sessions.js";
import { WORKSPACE_MUTATION_GUARD_COMPAT_RECORD } from "./workspace-mutation-guard.js";

const ACTIVATION_HINT_METADATA = {
  status: "active",
  owner: "plugin-execution",
  introduced: "2026-04-24",
  docsPath: "/plugins/manifest",
  diagnostics: ["activation plan compat reason"],
  tests: ["src/plugins/activation-planner.test.ts"],
} as const;

export const PLUGIN_COMPAT_RECORDS = [
  ...PLUGIN_SDK_REMOVED_EXPORT_RECORDS,
  ...AGENT_HARNESS_COMPAT_RECORDS,
  ...BINDING_PERSISTENCE_COMPAT_RECORDS,
  CHANNEL_PAIRING_COMPAT_RECORD,
  MENTION_INBOX_COMPAT_RECORD,
  MODEL_ACCOUNT_CONNECT_COMPAT_RECORD,
  WORKSPACE_MUTATION_GUARD_COMPAT_RECORD,
  ...SESSION_PERSISTENCE_COMPAT_RECORDS,
  SKILL_COMMAND_DISCOVERY_COMPAT_RECORD,
  ...SQLITE_RUNTIME_COMPAT_RECORDS,
  NATIVE_EXEC_APPROVAL_COMPAT_RECORD,
  TTS_PREFERENCES_COMPAT_RECORD,
  ...AGENT_LIST_RUNTIME_PROJECTION_COMPAT_RECORDS,
  WATCHED_SESSIONS_COMPAT_RECORD,
  PROGRESS_RECEIPT_HANDOFF_COMPAT_RECORD,
  {
    code: "gateway-placement-sync-results",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-09-07",
    deprecated: "2026-10-02",
    warningStarts: "2026-10-02",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await getManyAsync, retireSessionPlacementAsync, listPendingWorkspaceResultsAsync, getWorkspaceResultReconcilingSessionIdsAsync, getAdmittedDeviceSessionCountsAsync, and deferOrphanedRequestsAsync on the Gateway context. For placement standing-grant preparation, await resolveBindingAsync, retainAsync, and validateAsync; keep consume synchronous at final transport authorization. Released synchronous methods retain their signatures, return values, and completion timing until the next Plugin SDK major and explicit breaking-release approval.",
    docsPath:
      "/plugins/sdk-migration/compatibility-policy#gateway-placement-and-publication-readers",
    surfaces: [
      "GatewayRequestHandlerOptions.context.workerSessionPlacementService.getMany",
      "GatewayRequestHandlerOptions.context.workerSessionPlacementService.retireSessionPlacement",
      "GatewayRequestHandlerOptions.context.workerSessionPlacementService.clearLocalTurnClaimsAfterRestart",
      "GatewayRequestHandlerOptions.context.workerPlacementDispatchService.getAdmittedDeviceSessionCounts",
      "GatewayRequestHandlerOptions.context.placementStandingGrants.resolveBinding",
      "GatewayRequestHandlerOptions.context.placementStandingGrants.retain",
      "GatewayRequestHandlerOptions.context.placementStandingGrants.validate",
      "GatewayRequestHandlerOptions.context.workerSessionPlacementService.listPendingWorkspaceResults",
      "GatewayRequestHandlerOptions.context.workerSessionPlacementService.getWorkspaceResultReconcilingSessionIds",
      "GatewayRequestHandlerOptions.context.githubPublicationService.deferOrphanedRequests",
      "getPluginRuntimeGatewayRequestScope().context",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; placement retirement and restart clearing warn once per plugin and capability family on legacy use",
    ],
    tests: [
      "src/plugin-sdk/gateway-placement-compat.test.ts",
      "src/gateway/worker-environments/placement-store.test.ts",
      "src/gateway/worker-environments/placement-turn-claims.worker.test.ts",
      "src/gateway/operator-approval-placement-grants.test.ts",
      "src/gateway/worker-environments/device-placement-demand.test.ts",
      "src/gateway/github-publication-boundaries.test.ts",
      "src/gateway/github-repository-publication.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "Placement reads, retirement, device demand, standing-grant preparation, and GitHub orphan deferral expose awaited methods while retaining the synchronous Gateway-context contracts shipped to plugins in 2026.9.7, 2026.9.8, and 2026.10.1-beta.1. Internal placement operations use the SQLite worker; stored data and update behavior are unchanged.",
  },
  {
    code: "memory-session-sync-inventory",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-08-09",
    deprecated: "2026-10-01",
    warningStarts: "2026-10-01",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await loadArchivedSessionsAsync and resolveMemorySessionTargetsAsync from memory-core-host-engine-sessions. Synchronous readers retain their existing signatures and results until the next Plugin SDK major.",
    docsPath: "/plugins/sdk-migration/compatibility-policy#memory-session-inventory-readers",
    surfaces: ["loadArchivedSessions", "resolveMemorySessionTargets"],
    diagnostics: [
      "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/plugin-sdk/memory-core-host-engine-sessions.test.ts",
      "src/plugins/compat/registry.test.ts",
      "extensions/memory-core/src/memory-forget.sources.test.ts",
    ],
    releaseNote:
      "Memory archive discovery and forget target selection can be awaited through worker-backed SDK readers; synchronous readers remain compatible until the next Plugin SDK major.",
  },
  {
    code: "channel-webhook-listener-config-inputs",
    status: "deprecated",
    owner: "config",
    introduced: "2026-09-26",
    deprecated: "2026-09-26",
    warningStarts: "2026-09-26",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Use legacyWebhook for canonical listener config. Doctor migrates stored webhookPort/webhookHost and webhook.port inputs; deprecated optional TypeScript properties preserve config producer source compatibility until an approved SDK major removal.",
    docsPath: "/gateway/doctor/config-migrations#channel-webhook-listeners",
    surfaces: [
      "TelegramAccountConfig.webhookPort",
      "TelegramAccountConfig.webhookHost",
      "FeishuConfig.webhookPort",
      "FeishuConfig.webhookHost",
      "FeishuAccountConfig.webhookPort",
      "FeishuAccountConfig.webhookHost",
      "MSTeamsWebhookConfig.port",
      "NextcloudTalkAccountConfig.webhookPort",
      "NextcloudTalkAccountConfig.webhookHost",
    ],
    diagnostics: ["TypeScript @deprecated annotations and plugin-owned Doctor migration"],
    tests: [
      "extensions/telegram/src/doctor.test.ts",
      "extensions/feishu/src/doctor-contract.test.ts",
      "extensions/msteams/config-doctor-api.test.ts",
      "extensions/nextcloud-talk/src/doctor-contract.test.ts",
    ],
  },
  {
    code: "conversation-binding-sync-mutations",
    status: "deprecated",
    owner: "channel",
    introduced: "2026-09-20",
    deprecated: "2026-09-20",
    warningStarts: "2026-09-20",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await getSessionBindingService().bind, unbind, inspectByConversationAsync, resolveByConversationAsync, touchAsync, resolveRuntimeConversationBindingRouteAsync, and the Async-suffixed thread-binding lifecycle setters. Bundled current-conversation mutations and session listings use the existing worker owner. Project prepared inspection facts with inspectRuntimeConversationBindingRoute. Legacy external adapters retain their synchronous projection contract.",
    docsPath: "/plugins/sdk-runtime/channel#awaited-conversation-binding-mutations",
    surfaces: [
      "SessionBindingService.touch",
      "SessionBindingService.resolveByConversation",
      "SessionBindingAdapter.touch",
      "SessionBindingAdapter.resolveByConversation",
      "resolveRuntimeConversationBindingRoute",
      "ChannelConversationBindingSupport.setIdleTimeoutBySessionKey",
      "ChannelConversationBindingSupport.setMaxAgeBySessionKey",
      "api.runtime.channel.threadBindings.setIdleTimeoutBySessionKey",
      "api.runtime.channel.threadBindings.setMaxAgeBySessionKey",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations on synchronous methods; resolver migration is recorded here and in docs while its broad barrel remains deprecated; no runtime warnings",
    ],
    tests: [
      "src/infra/outbound/session-binding-service.test.ts",
      "src/channels/plugins/binding-routing.test.ts",
      "src/channels/plugins/conversation-bindings.test.ts",
    ],
    releaseNote:
      "Plugins can expose explicitly awaited binding mutations and pure ownership inspection; synchronous public methods remain supported while callers and persistence owners migrate.",
  },
  ...PLUGIN_SDK_SUBPATH_RECORDS,
  ...BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_RECORDS,
  ...DEPRECATION_MARKING_COMPAT_RECORDS,
  MEDIA_LEGACY_PROJECTION_COMPAT_RECORD,
  {
    code: "node-workspace-sync-acquisition",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-08-21",
    deprecated: "2026-09-15",
    warningStarts: "2026-09-15",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Await context.acquireManagedWorkspaceAsync(request) and release the returned lease in finally. Retain synchronous acquisition for supported external plugins until explicit breaking-release approval.",
    docsPath: "/plugins/sdk-migration/how-to-migrate#managed-node-workspace-acquisition",
    surfaces: ["OpenClawPluginNodeHostCommandContext.acquireManagedWorkspace"],
    diagnostics: [
      "TypeScript @deprecated annotation and migration documentation; no runtime warnings",
    ],
    tests: [
      "src/node-host/invoke-workspace.test.ts",
      "src/node-host/node-worker-workspace-retention.test.ts",
      "extensions/codex/src/node-exec-server.test.ts",
    ],
    releaseNote:
      "Node-host plugins can await managed workspace acquisition while existing synchronous callers retain their immediate lease contract.",
  },
  {
    code: "plugin-state-sync-keyed-store",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-05-29",
    deprecated: "2026-09-11",
    warningStarts: "2026-09-11",
    removalGate: "next-plugin-sdk-major",
    replacement:
      "Use api.runtime.state.openKeyedStoreV2 or createPluginStateKeyedStoreV2, await data-only operations, and replace update/deleteIf closures with observe/compareAndApply. Synchronous methods retain commit-before-return until they are removed in the next Plugin SDK major and explicit breaking-release approval.",
    docsPath: "/plugins/sdk-runtime/state-and-system#synchronous-keyed-store-migration",
    surfaces: [
      "api.runtime.state.openSyncKeyedStore",
      "PluginStateSyncKeyedStore",
      "createPluginStateSyncKeyedStore",
      "PluginStateKeyedStore.update",
      "PluginStateKeyedStore.deleteIf",
    ],
    diagnostics: [
      "TypeScript @deprecated annotations and state-store migration documentation",
      "plugin compatibility inventory; legacy writer migrations use the shared once-per-plugin-and-capability-family warning policy",
    ],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "src/plugin-state/plugin-state-store.test.ts",
      "src/plugin-state/plugin-state-store.runtime.test.ts",
      "test/type-contracts/plugin-state-store-runtime.ts",
      "src/plugins/loader.runtime-registry.test.ts",
    ],
    releaseNote:
      "Bundled plugins use worker-owned keyed-state operations and conditional prepared writes. Released synchronous stores and opaque callbacks retain their timing with a bounded migration warning; schemas, retention, and update behavior are unchanged.",
  },
  {
    code: "memory-read-result-statusless-success",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-04-28",
    deprecated: "2026-08-19",
    warningStarts: "2026-08-19",
    removalGate: "next-plugin-sdk-major",
    replacement: '`MemoryReadResult` with explicit `status: "ok" | "not_found"`',
    docsPath: "/plugins/sdk-migration#memory-read-missing-results",
    surfaces: ["statusless external memory manager read results"],
    diagnostics: ["host memory-manager acquisition adapter"],
    tests: ["src/plugins/memory-runtime.test.ts", "src/plugins/compat/registry.test.ts"],
    releaseNote:
      "External memory managers must return explicit not-found status for absence; statusless results retain legacy successful-read semantics through the next Plugin SDK major.",
  },
  {
    code: "context-engine-legacy-host-param-default",
    status: "removed",
    owner: "sdk",
    introduced: "2026-07-29",
    replacement:
      "`ContextEngineInfo.acceptedHostParams` for restricted projection; omitted declarations receive full host params",
    docsPath: "/concepts/context-engine#the-contextengine-interface",
    surfaces: ["ContextEngineInfo.acceptedHostParams and undeclared-engine default projection"],
    diagnostics: ["plugin compatibility registry and context engine guide"],
    tests: ["src/context-engine/host-param-projection.test.ts"],
    releaseNote:
      "The undeclared context-engine host-parameter compatibility default was removed; engines without `acceptedHostParams` now receive all current host fields.",
  },
  {
    code: "removed-global-api-provider-publication",
    status: "removed",
    owner: "sdk",
    introduced: "2026-05-27",
    replacement:
      "provider plugins via `api.registerProvider(...)`; host/runtime code registers against its lifecycle-owned `ApiRegistry`",
    docsPath: "/plugins/sdk-migration#process-global-api-provider-publication",
    surfaces: [
      "openclaw/plugin-sdk/llm registerApiProvider",
      "openclaw/plugin-sdk/llm unregisterApiProviders",
    ],
    diagnostics: ["plugin SDK compatibility registry and migration guide"],
    tests: ["src/plugins/compat/registry.test.ts"],
    releaseNote:
      "The process-global API-provider publication facade was removed; provider plugins now publish through their lifecycle-owned registration, and host runtimes register directly on their prepared ApiRegistry.",
  },
  {
    code: "legacy-deactivate-hook-alias",
    status: "removed",
    owner: "sdk",
    introduced: "2026-05-16",
    replacement: "`gateway_stop` hook",
    docsPath: "/plugins/sdk-migration#deactivate-hook-alias",
    surfaces: ['api.on("deactivate", ...)', "plugin typed hook registration"],
    diagnostics: ["plugin compatibility registry and migration guide"],
    tests: ["src/plugins/compat/registry.test.ts"],
    releaseNote:
      'The deprecated `api.on("deactivate", ...)` hook alias was removed; plugins must register cleanup with `gateway_stop`.',
  },
  {
    code: "legacy-subagent-spawning-hook",
    status: "removed",
    owner: "sdk",
    introduced: "2026-05-30",
    replacement:
      "`subagent_spawned` for post-launch observation; core session-binding adapters for thread routing",
    docsPath: "/plugins/hooks#upcoming-deprecations",
    surfaces: [
      'api.on("subagent_spawning", ...)',
      "PluginHookSubagentSpawningEvent",
      "PluginHookSubagentSpawningResult",
      "SubagentLifecycleHookRunner.runSubagentSpawning",
    ],
    diagnostics: ["plugin compatibility registry and migration guide"],
    tests: ["src/plugins/compat/registry.test.ts"],
    releaseNote:
      '`api.on("subagent_spawning", ...)` was removed; core now owns thread-bound subagent routing, and `subagent_spawned` remains available for observation.',
  },
  SKILL_PROPOSAL_HOOKS_COMPAT_RECORD,
  {
    code: "hook-only-plugin-shape",
    status: "active",
    owner: "sdk",
    introduced: "2026-04-24",
    replacement: "explicit capability registration",
    docsPath: "/plugins/sdk-migration",
    surfaces: ["plugin shape inspection", "plugins inspect", "status diagnostics"],
    diagnostics: ["plugin compatibility notice"],
    tests: ["src/plugins/status.test.ts", "src/plugins/contracts/shape.contract.test.ts"],
  },
  {
    code: "deprecated-memory-embedding-provider-api",
    status: "removed",
    owner: "sdk",
    introduced: "2026-05-21",
    replacement: "`api.registerEmbeddingProvider(...)` and `contracts.embeddingProviders`",
    docsPath: "/plugins/sdk-migration#memory-embedding-provider-api",
    surfaces: [
      "api.registerMemoryEmbeddingProvider(...)",
      "contracts.memoryEmbeddingProviders",
      "openclaw/plugin-sdk/memory-core-host-engine-embeddings registerMemoryEmbeddingProvider",
      "plugin compatibility registry and migration guide",
    ],
    diagnostics: ["plugin compatibility registry and migration guide"],
    tests: ["src/plugins/compat/registry.test.ts"],
    releaseNote:
      "Memory-specific embedding provider registration was removed; plugins now use the generic embedding provider contract.",
  },
  {
    code: "plugin-sdk-session-agent-resolution-aliases",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-08-29",
    deprecated: "2026-08-29",
    warningStarts: "2026-08-29",
    removeAfter: "2026-11-29",
    replacement:
      "`resolveSessionAgentIdsStrict` and `resolveSessionAgentIdStrict` with an explicit agent, agent-scoped session key, prepared fallback, or persisted owner",
    docsPath: "/plugins/compatibility#session-agent-resolution-aliases",
    surfaces: [
      "openclaw/plugin-sdk/agent-scope-runtime resolveSessionAgentIds and resolveSessionAgentId",
      "openclaw/plugin-sdk/agent-runtime session-agent resolver aliases",
      "openclaw/plugin-sdk/agent-harness-runtime session-agent resolver aliases",
      "openclaw/plugin-sdk/memory-core-host-runtime-core session-agent resolver alias",
      "openclaw/plugin-sdk/memory-host-core session-agent resolver alias",
    ],
    diagnostics: ["TypeScript deprecated SDK alias annotations", "plugin compatibility registry"],
    tests: ["src/plugin-sdk/agent-scope-runtime.test.ts", "src/plugins/compat/registry.test.ts"],
    releaseNote:
      "Legacy Plugin SDK session-agent resolver names preserve ambient system-agent fallback while published plugins migrate to strict owner-required aliases.",
  },
  {
    code: "agent-harness-credential-prompt-string-argument",
    status: "deprecated",
    owner: "sdk",
    introduced: "2026-08-08",
    deprecated: "2026-09-09",
    warningStarts: "2026-09-09",
    removeAfter: "2026-11-30",
    replacement: "options object `{ controlToolsAvailable }`",
    docsPath: "/plugins/sdk-migration/removed-surfaces#credential-prompt-builder",
    surfaces: [
      "openclaw/plugin-sdk/agent-harness-runtime buildCredentialSafetyPrompt string argument",
    ],
    diagnostics: ["JSDoc parameter deprecation", "plugin compatibility registry"],
    tests: ["src/agents/credential-safety-prompt.test.ts"],
    releaseNote:
      "The credential prompt helper remains available with private login-code handoff and capability-aware terminal setup guidance; its ignored legacy string argument is supported through 2026-11-30.",
  },
  {
    code: "removed-session-transcript-file-api",
    status: "removed",
    owner: "sdk",
    introduced: "2026-07-01",
    replacement:
      "session identity (`sessionKey`/`sessionId`), `SessionTranscriptUpdate.target`, and Gateway/runtime session helpers",
    docsPath: "/plugins/sdk-migration#removed-session-and-transcript-file-apis",
    surfaces: [
      "saveSessionStore",
      "resolveSessionTranscriptPathInDir",
      "resolveAndPersistSessionFile",
      "readLatestAssistantTextFromSessionTranscript",
      "SessionTranscriptUpdate.sessionFile",
      "sessionFiles",
      "transcriptPath",
      "sessionFile",
      "plugins inspect compatibility notices",
    ],
    diagnostics: ["plugin compatibility notice"],
    tests: ["src/plugins/status.test.ts", "src/plugins/compat/registry.test.ts"],
    releaseNote:
      "Session/transcript file APIs were removed with the SQLite session storage flip; plugins now use session identity and Gateway/runtime session helpers.",
  },
  {
    code: "hook.before_tool_call.terminal-block-approval",
    status: "active",
    owner: "agent-runtime",
    introduced: "2026-04-29",
    docsPath: "/plugins/hooks",
    surfaces: ["before_tool_call block result", "before_tool_call approval result"],
    diagnostics: ["hook runner contract check"],
    tests: ["src/agents/agent-tools.before-tool-call.e2e.test.ts"],
  },
  {
    code: "hook.llm-observer.privacy-payload",
    status: "active",
    owner: "agent-runtime",
    introduced: "2026-04-29",
    docsPath: "/plugins/hooks",
    surfaces: ["llm_input", "llm_output", "agent_end", "allowConversationAccess"],
    diagnostics: ["conversation access hook contract check"],
    tests: ["src/agents/cli-runner.reliability.test.ts", "src/config/schema.help.quality.test.ts"],
  },
  {
    code: "api.capture.runtime-registrars",
    status: "active",
    owner: "plugin-execution",
    introduced: "2026-04-29",
    docsPath: "/plugins/architecture-internals",
    surfaces: [
      "createCapturedPluginRegistration",
      "capturePluginRegistration",
      "OpenClawPluginApi",
    ],
    diagnostics: ["runtime registration capture contract check"],
    tests: ["src/plugins/captured-registration.test.ts"],
  },
  {
    code: "channel.runtime.envelope-config-metadata",
    status: "active",
    owner: "channel",
    introduced: "2026-04-29",
    docsPath: "/plugins/sdk-channel-plugins",
    surfaces: ["api.registerChannel", "channel setup metadata", "channel message envelope"],
    diagnostics: ["channel runtime contract check"],
    tests: [
      "src/plugin-sdk/channel-entry-contract.test.ts",
      "src/plugins/captured-registration.test.ts",
    ],
  },
  {
    code: "whatsapp-web-inbound-flat-message-aliases",
    status: "removed",
    owner: "channel",
    introduced: "2026-05-30",
    replacement:
      "WhatsApp `WebInboundCallbackMessage` nested contexts: `event`, `payload`, `quote`, `group`, and `platform`",
    docsPath: "/plugins/compatibility",
    surfaces: [
      "@openclaw/whatsapp WebInboundMessage flat fields",
      "WhatsApp monitorWebInbox onMessage callback",
      "WhatsApp monitorWebChannel listenerFactory injected messages",
    ],
    diagnostics: ["plugin compatibility registry and compatibility guide"],
    tests: ["src/plugins/compat/registry.test.ts"],
    releaseNote:
      "WhatsApp WebInboundMessage flat fields were removed; callbacks now receive only nested inbound contexts.",
  },
  {
    code: "whatsapp-web-inbound-admission-top-level-fields",
    status: "removed",
    owner: "channel",
    introduced: "2026-06-14",
    replacement:
      "WhatsApp `WebInboundMessage.admission` fields: `conversation.id`, `accountId`, `ingress.decision`, and `conversation.kind`",
    docsPath: "/plugins/compatibility",
    surfaces: [
      "@openclaw/whatsapp WebInboundMessage top-level admission fields",
      "WhatsApp monitorWebInbox onMessage callback",
      "WhatsApp monitorWebChannel listenerFactory injected messages",
    ],
    diagnostics: ["plugin compatibility registry and compatibility guide"],
    tests: ["src/plugins/compat/registry.test.ts"],
    releaseNote:
      "WhatsApp WebInboundMessage top-level admission fields were removed; callbacks now read the canonical admission envelope.",
  },
  {
    code: "sdk-untrusted-context-identifier-aliases",
    status: "removal-pending",
    owner: "sdk",
    introduced: "2026-07-22",
    deprecated: "2026-07-22",
    warningStarts: "2026-07-22",
    removeAfter: "2026-09-08",
    replacement:
      "`MsgContext.ChannelPromptContext`, `MsgContext.ChannelStructuredContext`, `ChannelStructuredContextEntry`, `SupplementalContextFacts.channelStructuredContext`, and `buildChannelMetadata`; retain the aliases until migration of published plugin readers is verified and explicit breaking-release approval is granted",
    docsPath: "/plugins/compatibility",
    surfaces: [
      "openclaw/plugin-sdk reply-runtime MsgContext.UntrustedContext and UntrustedStructuredContext",
      "openclaw/plugin-sdk reply-runtime UntrustedStructuredContextEntry",
      "openclaw/plugin-sdk channel-inbound SupplementalContextFacts.untrustedContext",
      "openclaw/plugin-sdk security-runtime buildUntrustedChannelMetadata",
    ],
    diagnostics: ["TypeScript deprecated SDK alias annotations"],
    tests: ["src/auto-reply/reply/inbound-context.test.ts"],
    releaseNote:
      "Untrusted-named prompt-context SDK identifiers remain wired as deprecated aliases of the channel-named fields while plugins migrate.",
  },
  {
    code: "channel-explicit-target-parser",
    status: "removed",
    owner: "sdk",
    introduced: "2026-04-28",
    replacement:
      "`messaging.targetResolver` for target normalization and `messaging.resolveOutboundSessionRoute` for session/thread identity",
    docsPath: "/plugins/sdk-migration",
    surfaces: [
      "ChannelMessagingAdapter.parseExplicitTarget",
      "openclaw/plugin-sdk/channel-route ChannelRouteExplicitTarget",
      "openclaw/plugin-sdk/channel-route ChannelRouteExplicitTargetParser",
      "openclaw/plugin-sdk/channel-route resolveChannelRouteTargetWithParser",
    ],
    diagnostics: ["plugin SDK compatibility warning"],
    tests: [
      "src/channels/plugins/contracts/test-helpers/surface-contract-suite.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "The deprecated channel explicit-target parser was removed; plugins must normalize targets with `messaging.targetResolver` and project session identity with `messaging.resolveOutboundSessionRoute`.",
  },
  {
    code: "channel-messaging-targets-subpath",
    status: "removed",
    owner: "sdk",
    introduced: "2026-04-28",
    replacement: "`openclaw/plugin-sdk/channel-targets`",
    docsPath: "/plugins/sdk-migration",
    surfaces: ["openclaw/plugin-sdk/messaging-targets"],
    diagnostics: ["plugin SDK compatibility warning"],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
    ],
    releaseNote:
      "The deprecated `openclaw/plugin-sdk/messaging-targets` subpath was removed; import target helpers from `openclaw/plugin-sdk/channel-targets`.",
  },
  {
    code: "bundled-plugin-allowlist",
    status: "active",
    owner: "config",
    introduced: "2026-04-24",
    replacement: "manifest-owned plugin enablement and scoped load plans",
    docsPath: "/plugins/architecture",
    surfaces: ["plugins.allow", "bundled provider startup", "plugins status"],
    diagnostics: ["plugin status report"],
    tests: ["src/plugins/status.test.ts", "src/plugins/config-state.test.ts"],
  },
  {
    code: "bundled-plugin-enablement",
    status: "active",
    owner: "config",
    introduced: "2026-04-24",
    replacement: "manifest-owned plugin defaults and scoped load plans",
    docsPath: "/plugins/architecture",
    surfaces: ["plugins.entries", "bundled provider startup", "plugins status"],
    diagnostics: ["plugin status report"],
    tests: ["src/plugins/status.test.ts", "src/plugins/config-state.test.ts"],
  },
  {
    code: "activation-agent-harness-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement:
      "top-level `cliBackends[]` for CLI aliases and future `agentRuntime` ownership metadata",
    surfaces: ["activation.onAgentHarnesses", "activation planner"],
  },
  {
    code: "activation-provider-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement: "`providers[]` manifest ownership",
    surfaces: ["activation.onProviders", "activation planner"],
  },
  {
    code: "activation-channel-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement: "`channels[]` manifest ownership",
    surfaces: ["activation.onChannels", "activation planner"],
  },
  {
    code: "activation-command-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement: "`commandAliases` or command contribution metadata",
    surfaces: ["activation.onCommands", "activation planner"],
  },
  {
    code: "activation-route-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement: "HTTP route contribution metadata",
    surfaces: ["activation.onRoutes", "activation planner"],
  },
  {
    code: "activation-config-path-hint",
    ...ACTIVATION_HINT_METADATA,
    introduced: "2026-04-27",
    replacement: "manifest contribution ownership for root config surfaces",
    surfaces: ["activation.onConfigPaths", "startup plugin selection"],
    tests: ["src/plugins/channel-plugin-ids.test.ts"],
  },
  {
    code: "activation-capability-hint",
    ...ACTIVATION_HINT_METADATA,
    replacement: "manifest contribution ownership",
    surfaces: ["activation.onCapabilities", "activation planner"],
  },
  {
    code: "embedded-pi-agent-sdk-aliases",
    status: "removed",
    owner: "agent-runtime",
    introduced: "2026-05-21",
    replacement: "`runEmbeddedAgent` and `EmbeddedAgent*` SDK/runtime names",
    docsPath: "/plugins/sdk-runtime",
    surfaces: [
      "api.runtime.agent.runEmbeddedPiAgent",
      "openclaw/extension-api runEmbeddedPiAgent",
      "openclaw/plugin-sdk/agent-harness-runtime EmbeddedPi* aliases",
    ],
    diagnostics: ["plugin SDK compatibility registry"],
    tests: [
      "src/plugins/runtime/index.test.ts",
      "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
    ],
    releaseNote:
      "The legacy `runEmbeddedPiAgent` and `EmbeddedPi*` plugin aliases were removed; plugins must use the neutral embedded-agent names.",
  },
  {
    code: "plugin-sdk-shipped-channel-setup-exports",
    status: "deprecated",
    owner: "channel",
    introduced: "2026-07-23",
    deprecated: "2026-07-23",
    warningStarts: "2026-07-23",
    replacement:
      "retain until supported published packages migrate to plugin-owned config schemas plus generic `openclaw/plugin-sdk/channel-config-schema` and `openclaw/plugin-sdk/setup-runtime` primitives",
    docsPath: "/plugins/sdk-migration#published-channel-setup-compatibility",
    surfaces: [
      "openclaw/plugin-sdk/bundled-channel-config-schema SlackConfigSchema",
      "openclaw/plugin-sdk/bundled-channel-config-schema DiscordConfigSchema",
      "openclaw/plugin-sdk/bundled-channel-config-schema SignalConfigSchema",
      "openclaw/plugin-sdk/bundled-channel-config-schema MSTeamsConfigSchema",
      "openclaw/plugin-sdk/setup-runtime createLegacyCompatChannelDmPolicy",
      "openclaw/plugin-sdk/setup-runtime promptLegacyChannelAllowFromForAccount",
    ],
    diagnostics: [
      "repository deprecated API usage guard for core and bundled plugins; no external runtime import warning",
    ],
    tests: ["src/plugin-sdk/shipped-channel-compat.test.ts", "src/plugins/compat/registry.test.ts"],
    releaseNote:
      "Published OpenClaw channel packages through 2026.7.1 remain loadable while they migrate to plugin-owned config and setup helpers.",
  },
  {
    code: "generated-bundled-channel-config-fallback",
    status: "active",
    owner: "channel",
    introduced: "2026-04-24",
    replacement: "manifest registry `channelConfigs` metadata",
    docsPath: "/plugins/manifest",
    surfaces: ["generated bundled channel config metadata", "channel config validation"],
    diagnostics: ["channel config metadata fallback"],
    tests: ["src/plugins/contracts/config-footprint-guardrails.test.ts"],
  },
  {
    code: "setup-runtime-fallback",
    status: "active",
    owner: "setup",
    introduced: "2026-04-24",
    replacement: "`setup.requiresRuntime: false` with complete setup descriptors",
    docsPath: "/plugins/manifest/setup-and-auth#setup-reference",
    surfaces: ["setup-api runtime fallback", "setup.requiresRuntime omitted"],
    diagnostics: ["setup registry runtime diagnostic"],
    tests: ["src/plugins/setup-registry.test.ts", "src/plugins/setup-registry.runtime.test.ts"],
  },
] as const satisfies readonly PluginCompatRecord[];
