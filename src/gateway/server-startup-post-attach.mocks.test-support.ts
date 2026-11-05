import { vi } from "vitest";
import type { PluginServicesHandle } from "../plugins/services.js";

const postAttachMocks = vi.hoisted(() => {
  const commitInternalHooks = vi.fn(() => true);
  const startupHookEvent = { type: "gateway", action: "startup", sessionKey: "gateway:startup" };
  const updateCheck = {
    initialize: vi.fn(async () => ({
      root: null,
      status: { root: null, installKind: "unknown" as const, packageManager: "unknown" as const },
      installReceipt: null,
    })),
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  return {
    startPluginServices: vi.fn<typeof import("../plugins/services.js").startPluginServices>(
      async (params) => {
        const handle: PluginServicesHandle = { reload: async () => {}, stop: async () => {} };
        params.onHandle?.(handle);
        return handle;
      },
    ),
    startGmailWatcherWithLogs: vi.fn(async () => {}),
    prepareInternalHooks: vi.fn(async () => ({ loadedCount: 0, commit: commitInternalHooks })),
    commitInternalHooks,
    hasInternalHookListeners: vi.fn(() => false),
    startupHookEvent,
    createInternalHookEvent: vi.fn(() => startupHookEvent),
    triggerInternalHook: vi.fn(async () => {}),
    updateCheck,
    createGatewayUpdateCheck: vi.fn(() => updateCheck),
    logGatewayStartup: vi.fn(),
    activateSubagentRegistry: vi.fn(async () => {}),
    resumeMarkedSessions: vi.fn(async () => {}),
    getAcpRuntimeBackend: vi.fn<(id?: string) => unknown>(() => null),
    reconcilePendingSessionIdentities: vi.fn(async () => ({ checked: 0, resolved: 0, failed: 0 })),
    isCliProvider: vi.fn(() => false),
    resolveConfiguredModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-5.4" })),
    resolveHooksGmailModel: vi.fn<() => { provider: string; model: string } | null>(() => null),
    loadFullModelCatalog: vi.fn(async () => {
      throw new Error("full model catalog should not materialize");
    }),
    loadModelCatalog: vi.fn(async (_options?: unknown): Promise<unknown> => ({})),
    getModelRefStatus: vi.fn(() => ({ key: "openai/gpt-5.4", allowed: true, inCatalog: true })),
    prepareModelRuntimeSnapshot: vi.fn(async () => ({})),
    refreshPreparedModelRuntimeSnapshots: vi.fn<
      typeof import("../agents/prepared-model-runtime.js").refreshPreparedModelRuntimeSnapshots
    >(async () => {}),
    prewarmConfigDrivenReplyRuntime: vi.fn(async () => {}),
    scheduleGatewayHandlerPrewarm: vi.fn(() => ({ stop: vi.fn() })),
  };
});

export { postAttachMocks };

// mock-isolation: Keep persisted subagent restoration and registry timers outside startup ordering.
vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({
  activateSubagentRegistry: postAttachMocks.activateSubagentRegistry,
}));

// mock-isolation: Durable persistence and observation own workers outside this startup fixture.
vi.mock("../agents/bash-process-durable.js", () => ({
  initializeDurableProcesses: vi.fn(async () => {}),
  disposeDurableProcesses: vi.fn(async () => {}),
}));

// mock-isolation: This worker-free ordering fixture has no pending agent deletions.
vi.mock("./server-agent-deletion-recovery.js", () => ({
  resumeAgentDeletions: vi.fn(async () => {}),
}));

// mock-isolation: Acceptance E2E owns persisted marker admission; startup fixtures use partial contexts.
vi.mock("./session-restart-resume.js", () => ({
  resumeMarkedSessions: postAttachMocks.resumeMarkedSessions,
}));

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return {
    ...actual,
    get STATE_DIR() {
      return actual.resolveStateDir();
    },
    get CONFIG_PATH() {
      return actual.resolveConfigPath();
    },
    resolveGatewayPort: vi.fn(() => 18789),
  };
});

// mock-isolation: Exercise watcher scheduling without loading Gmail credentials or opening a watcher.
vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: postAttachMocks.startGmailWatcherWithLogs,
}));

// mock-isolation: Capture startup hook dispatch without invoking process-wide registered handlers.
vi.mock("../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: postAttachMocks.createInternalHookEvent,
  hasInternalHookListeners: postAttachMocks.hasInternalHookListeners,
  triggerInternalHook: postAttachMocks.triggerInternalHook,
}));

// mock-isolation: Control hook preparation and commit without loading user hook modules.
vi.mock("../hooks/loader.js", () => ({
  prepareInternalHooks: postAttachMocks.prepareInternalHooks,
}));

// mock-isolation: Supply owned service handles without starting registered plugin services.
vi.mock("../plugins/services.js", () => ({
  startPluginServices: postAttachMocks.startPluginServices,
}));

// mock-isolation: Observe identity reconciliation without acquiring the process-wide ACP manager.
vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: vi.fn(() => ({
    reconcilePendingSessionIdentities: postAttachMocks.reconcilePendingSessionIdentities,
  })),
}));

// mock-isolation: Fixture cleanup must not dispose the real process-wide ACP manager.
vi.mock("../acp/control-plane/manager.lifecycle.js", () => ({
  disposeAcpSessionManagerInstance: vi.fn(async () => undefined),
}));

// mock-isolation: Control ACP backend readiness without accessing registered live runtimes.
vi.mock("../acp/runtime/registry.js", () => ({
  getAcpRuntimeBackend: postAttachMocks.getAcpRuntimeBackend,
}));

// mock-isolation: Capture startup logging without selecting a native SQLite library or reading worker state.
vi.mock("./server-startup-log.js", () => ({
  logGatewayStartup: postAttachMocks.logGatewayStartup,
}));

// mock-isolation: Control update-check lifetime without network refreshes or persistent update campaigns.
vi.mock("../infra/update-startup.js", () => ({
  createGatewayUpdateCheck: postAttachMocks.createGatewayUpdateCheck,
}));

// mock-isolation: Config publication owns the current-config producer, not external auth discovery.
vi.mock("./server-startup-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-startup-model-runtime.js")>();
  return {
    ...actual,
    hydrateConfiguredExternalCliAuth: async ({ getConfig }) => getConfig(),
  } satisfies typeof actual;
});

// mock-isolation: Sidecar scheduling does not own catalog or native-runtime preparation.
vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogOwnerSnapshot: async (options: unknown) => ({
    modelCatalog: { entries: await postAttachMocks.loadModelCatalog(options) },
  }),
}));

// mock-isolation: Supply configured model facts without consulting provider and catalog state.
vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: postAttachMocks.getModelRefStatus,
  isCliProvider: postAttachMocks.isCliProvider,
  resolveConfiguredModelRef: postAttachMocks.resolveConfiguredModelRef,
  resolveHooksGmailModel: postAttachMocks.resolveHooksGmailModel,
}));

// mock-isolation: Observe publication ordering without preparing credentials or changing runtime snapshots.
vi.mock("../agents/prepared-model-runtime.js", () => ({
  publishPreparedModelRuntimeSnapshot: postAttachMocks.prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots: postAttachMocks.refreshPreparedModelRuntimeSnapshots,
}));

// mock-isolation: Observe reply prewarming without dispatching turns or loading a native agent runtime.
vi.mock("../auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: vi.fn(),
  prewarmConfigDrivenReplyRuntime: postAttachMocks.prewarmConfigDrivenReplyRuntime,
}));

// mock-isolation: Startup owns the import, not WebSocket request execution.
vi.mock("./server/ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: vi.fn(),
}));

// mock-isolation: Startup orchestration does not run independent background preparation.
vi.mock("./server-startup-handler-prewarm.js", () => ({
  scheduleGatewayPrewarm: () => [postAttachMocks.scheduleGatewayHandlerPrewarm()],
}));
