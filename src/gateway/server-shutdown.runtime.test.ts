import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  loaded: [] as string[],
  loadedMock<T>(name: string, exports: T): T {
    state.loaded.push(name);
    return exports;
  },
  prepareClose: vi.fn(),
  drainEmbeddingProviders: vi.fn(),
  completeClose: vi.fn(),
  flushSessionChanges: vi.fn(),
  drainSessionPublications: vi.fn(),
  stopPlugins: vi.fn(),
  preparePluginRegistryShutdown: vi.fn(async () => undefined),
  artifactsAvailable: true,
  waitForPluginCacheRetirement: vi.fn(async () => undefined),
}));

// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("./server-close.runtime.js", () =>
  state.loadedMock("server-close", {
    prepareGatewayClose: state.prepareClose,
    completeGatewayClose: state.completeClose,
    drainActiveSessionsForShutdown: vi.fn(),
    runGatewayClosePrelude: vi.fn(),
  }),
);
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("../plugins/hook-runner-global.js", () =>
  state.loadedMock("plugin-hooks", { runGlobalGatewayStopSafely: state.stopPlugins }),
);
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("./server-methods/session-change-event.js", () =>
  state.loadedMock("session-change-events", {
    flushPendingSessionsChangedEvents: state.flushSessionChanges,
  }),
);
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("./session-event-prepared-row.js", () =>
  state.loadedMock("session-event-publications", {
    get drainSessionEventPublications() {
      if (!state.artifactsAvailable) {
        throw new Error("installed session-event-prepared-row chunk was removed");
      }
      return state.drainSessionPublications;
    },
  }),
);
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("./mcp-http.js", () => state.loadedMock("mcp-http", { closeMcpLoopbackServer: vi.fn() }));
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("../agents/agent-bundle-lsp-runtime.js", () =>
  state.loadedMock("bundle-lsp", { disposeAllBundleLspRuntimes: vi.fn() }),
);
vi.mock("./embeddings-http.js", () => {
  throw new Error("shutdown preparation must not load embeddings HTTP");
});
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("./embeddings-provider-lifetime.js", () =>
  state.loadedMock("embeddings", {
    drainRetainedOpenAiEmbeddingProviders: state.drainEmbeddingProviders,
  }),
);
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("../hooks/gmail-watcher.js", () =>
  state.loadedMock("gmail-watcher", { stopGmailWatcher: vi.fn() }),
);
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("../cron/maintenance.js", () =>
  state.loadedMock("cron-maintenance", { stopCronMaintenance: vi.fn() }),
);
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("../agents/code-mode-state.js", () =>
  state.loadedMock("code-mode", { disposeAllCodeModeRuns: vi.fn() }),
);
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("../agents/provider-transport-dispatcher-pool.js", () =>
  state.loadedMock("provider-transports", { closeProviderTransportDispatcherPool: vi.fn() }),
);
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("../plugins/runtime.js", () =>
  state.loadedMock("plugin-runtime", {
    prepareActivePluginRegistryShutdown: state.preparePluginRegistryShutdown,
  }),
);
// mock-isolation: Shutdown ordering records which modules load; real modules must stay unloaded.
vi.mock("../plugins/plugin-cache.js", () =>
  state.loadedMock("plugin-cache", {
    get waitForPluginCacheRetirement() {
      if (!state.artifactsAvailable) {
        throw new Error("installed plugin-cache chunk was removed");
      }
      return state.waitForPluginCacheRetirement;
    },
  }),
);
vi.mock("../agents/subagents/registry/subagent-session-cleanup.js", () => ({
  loadSubagentSessionCleanupRuntime: async () => undefined,
}));

const { prepareGatewayShutdownRuntime } = await import("./server-shutdown.runtime.js");

it("resolves every shutdown dependency during preparation", async () => {
  const runtime = await prepareGatewayShutdownRuntime();

  expect(state.loaded.toSorted()).toEqual(
    [
      "server-close",
      "plugin-hooks",
      "session-change-events",
      "session-event-publications",
      "mcp-http",
      "bundle-lsp",
      "embeddings",
      "gmail-watcher",
      "cron-maintenance",
      "code-mode",
      "provider-transports",
      "plugin-runtime",
      "plugin-cache",
    ].toSorted(),
  );
  expect(runtime.prepareGatewayClose).toBe(state.prepareClose);
  expect(runtime.drainRetainedOpenAiEmbeddingProviders).toBe(state.drainEmbeddingProviders);
  expect(runtime.completeGatewayClose).toBe(state.completeClose);
  expect(runtime.flushPendingSessionsChangedEvents).toBe(state.flushSessionChanges);
  expect(runtime.runGlobalGatewayStopSafely).toBe(state.stopPlugins);
  expect(state.preparePluginRegistryShutdown).toHaveBeenCalledOnce();
  expect(state.waitForPluginCacheRetirement).not.toHaveBeenCalled();
  expect(state.drainSessionPublications).not.toHaveBeenCalled();
  state.artifactsAvailable = false;
  try {
    expect(runtime.drainSessionEventPublications).toBe(state.drainSessionPublications);
    await runtime.waitForPluginCacheRetirement();
    expect(state.waitForPluginCacheRetirement).toHaveBeenCalledOnce();
  } finally {
    state.artifactsAvailable = true;
  }
});
