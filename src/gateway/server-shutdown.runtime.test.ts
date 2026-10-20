import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  runtime: {
    prepareGatewayClose: vi.fn(),
    completeGatewayClose: vi.fn(),
    drainActiveSessionsForShutdown: vi.fn(),
    runGatewayClosePrelude: vi.fn(),
    runGlobalGatewayStopSafely: vi.fn(),
    flushPendingSessionsChangedEvents: vi.fn(),
    drainSessionEventPublications: vi.fn(),
    closeMcpLoopbackServer: vi.fn(),
    markRestartAbortedMainSessions: vi.fn(),
    disposeAllBundleLspRuntimes: vi.fn(),
    drainRetainedOpenAiEmbeddingProviders: vi.fn(),
    stopGmailWatcher: vi.fn(),
    stopCronMaintenance: vi.fn(),
    disposeAllCodeModeRuns: vi.fn(),
    closeProviderTransportDispatcherPool: vi.fn(),
    waitForPluginCacheRetirement: vi.fn(async () => undefined),
  },
  preparePluginRegistryShutdown: vi.fn(async () => undefined),
  artifactsAvailable: true,
}));

vi.mock("./server-close.runtime.js", () => ({
  prepareGatewayClose: state.runtime.prepareGatewayClose,
  completeGatewayClose: state.runtime.completeGatewayClose,
  drainActiveSessionsForShutdown: state.runtime.drainActiveSessionsForShutdown,
  runGatewayClosePrelude: state.runtime.runGatewayClosePrelude,
}));
vi.mock("../plugins/hook-runner-global.js", () => ({
  runGlobalGatewayStopSafely: state.runtime.runGlobalGatewayStopSafely,
}));
vi.mock("./server-methods/session-change-event.js", () => ({
  flushPendingSessionsChangedEvents: state.runtime.flushPendingSessionsChangedEvents,
}));
vi.mock("./session-event-prepared-row.js", () => ({
  get drainSessionEventPublications() {
    if (!state.artifactsAvailable) {
      throw new Error("installed session-event-prepared-row chunk was removed");
    }
    return state.runtime.drainSessionEventPublications;
  },
}));
vi.mock("./mcp-http.js", () => ({ closeMcpLoopbackServer: state.runtime.closeMcpLoopbackServer }));
vi.mock("../agents/main-session-recovery/main-session-restart-recovery.js", () => ({
  markRestartAbortedMainSessions: state.runtime.markRestartAbortedMainSessions,
}));
vi.mock("../agents/agent-bundle-lsp-runtime.js", () => ({
  disposeAllBundleLspRuntimes: state.runtime.disposeAllBundleLspRuntimes,
}));
vi.mock("./embeddings-http.js", () => {
  throw new Error("shutdown preparation must not load embeddings HTTP");
});
vi.mock("./embeddings-provider-lifetime.js", () => ({
  drainRetainedOpenAiEmbeddingProviders: state.runtime.drainRetainedOpenAiEmbeddingProviders,
}));
vi.mock("../hooks/gmail-watcher.js", () => ({ stopGmailWatcher: state.runtime.stopGmailWatcher }));
vi.mock("../cron/maintenance.js", () => ({
  stopCronMaintenance: state.runtime.stopCronMaintenance,
}));
vi.mock("../agents/code-mode-state.js", () => ({
  disposeAllCodeModeRuns: state.runtime.disposeAllCodeModeRuns,
}));
vi.mock("../agents/provider-transport-dispatcher-pool.js", () => ({
  closeProviderTransportDispatcherPool: state.runtime.closeProviderTransportDispatcherPool,
}));
vi.mock("../plugins/runtime.js", () => ({
  prepareActivePluginRegistryShutdown: state.preparePluginRegistryShutdown,
}));
vi.mock("../plugins/plugin-cache.js", () => ({
  get waitForPluginCacheRetirement() {
    if (!state.artifactsAvailable) {
      throw new Error("installed plugin-cache chunk was removed");
    }
    return state.runtime.waitForPluginCacheRetirement;
  },
}));
vi.mock("../agents/subagents/registry/subagent-session-cleanup.js", () => ({
  loadSubagentSessionCleanupRuntime: async () => undefined,
}));

const { prepareGatewayShutdownRuntime } = await import("./server-shutdown.runtime.js");

it("resolves every shutdown dependency during preparation", async () => {
  const runtime = await prepareGatewayShutdownRuntime();
  expect(runtime).toEqual(state.runtime);
  expect(state.preparePluginRegistryShutdown).toHaveBeenCalledOnce();
  expect(state.runtime.waitForPluginCacheRetirement).not.toHaveBeenCalled();
  expect(state.runtime.drainSessionEventPublications).not.toHaveBeenCalled();
  state.artifactsAvailable = false;
  try {
    expect(runtime.drainSessionEventPublications).toBe(state.runtime.drainSessionEventPublications);
    await runtime.waitForPluginCacheRetirement();
    expect(state.runtime.waitForPluginCacheRetirement).toHaveBeenCalledOnce();
  } finally {
    state.artifactsAvailable = true;
  }
});
