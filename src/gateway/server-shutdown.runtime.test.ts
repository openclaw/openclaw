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

// mock-isolation: Record direct close-runtime loading without importing its real hook graph.
vi.mock("./server-close.runtime.js", () =>
  state.loadedMock("server-close", {
    prepareGatewayClose: state.prepareClose,
    completeGatewayClose: state.completeClose,
    drainActiveSessionsForShutdown: vi.fn(),
    runGatewayClosePrelude: vi.fn(),
  }),
);
// mock-isolation: Track stop-hook capture without initializing the real plugin hook singleton.
vi.mock("../plugins/hook-runner-global.js", () =>
  state.loadedMock("plugin-hooks", { runGlobalGatewayStopSafely: state.stopPlugins }),
);
// mock-isolation: Keep real event imports from loading the publication mock transitively.
vi.mock("./server-methods/session-change-event.js", () =>
  state.loadedMock("session-change-events", {
    flushPendingSessionsChangedEvents: state.flushSessionChanges,
  }),
);
// mock-isolation: The getter simulates a removed chunk after shutdown captures its callback.
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
// mock-isolation: Track the shutdown import without loading real MCP server state.
vi.mock("./mcp-http.js", () => state.loadedMock("mcp-http", { closeMcpLoopbackServer: vi.fn() }));
// mock-isolation: Track the shutdown import without loading real bundle and LSP state.
vi.mock("../agents/agent-bundle-lsp-runtime.js", () =>
  state.loadedMock("bundle-lsp", { disposeAllBundleLspRuntimes: vi.fn() }),
);
vi.mock("./embeddings-http.js", () => {
  throw new Error("shutdown preparation must not load embeddings HTTP");
});
// mock-isolation: Capture the drain callback without real retained embedding-provider state.
vi.mock("./embeddings-provider-lifetime.js", () =>
  state.loadedMock("embeddings", {
    drainRetainedOpenAiEmbeddingProviders: state.drainEmbeddingProviders,
  }),
);
// mock-isolation: Track the shutdown import independently of real Gmail watcher state.
vi.mock("../hooks/gmail-watcher.js", () =>
  state.loadedMock("gmail-watcher", { stopGmailWatcher: vi.fn() }),
);
// mock-isolation: Track the shutdown import independently of real maintenance timer state.
vi.mock("../cron/maintenance.js", () =>
  state.loadedMock("cron-maintenance", { stopCronMaintenance: vi.fn() }),
);
// mock-isolation: Track the shutdown import without real active Code Mode runs.
vi.mock("../agents/code-mode-state.js", () =>
  state.loadedMock("code-mode", { disposeAllCodeModeRuns: vi.fn() }),
);
// mock-isolation: Track the shutdown import without the real dispatcher pool.
vi.mock("../agents/provider-transport-dispatcher-pool.js", () =>
  state.loadedMock("provider-transports", { closeProviderTransportDispatcherPool: vi.fn() }),
);
// mock-isolation: Observe registry shutdown preparation without the real plugin registry singleton.
vi.mock("../plugins/runtime.js", () =>
  state.loadedMock("plugin-runtime", {
    prepareActivePluginRegistryShutdown: state.preparePluginRegistryShutdown,
  }),
);
// mock-isolation: The getter simulates a removed chunk after shutdown captures retirement.
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
