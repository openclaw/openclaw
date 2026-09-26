import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  loaded: [] as string[],
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

vi.mock("./server-close.runtime.js", () => {
  state.loaded.push("server-close");
  return {
    prepareGatewayClose: state.prepareClose,
    completeGatewayClose: state.completeClose,
    drainActiveSessionsForShutdown: vi.fn(),
    runGatewayClosePrelude: vi.fn(),
  };
});
vi.mock("../plugins/hook-runner-global.js", () => {
  state.loaded.push("plugin-hooks");
  return { runGlobalGatewayStopSafely: state.stopPlugins };
});
vi.mock("./server-methods/session-change-event.js", () => {
  state.loaded.push("session-change-events");
  return { flushPendingSessionsChangedEvents: state.flushSessionChanges };
});
vi.mock("./session-event-prepared-row.js", () => {
  state.loaded.push("session-event-publications");
  return {
    get drainSessionEventPublications() {
      if (!state.artifactsAvailable) {
        throw new Error("installed session-event-prepared-row chunk was removed");
      }
      return state.drainSessionPublications;
    },
  };
});
vi.mock("./mcp-http.js", () => {
  state.loaded.push("mcp-http");
  return { closeMcpLoopbackServer: vi.fn() };
});
vi.mock("../tasks/task-registry.maintenance.js", () => {
  state.loaded.push("task-maintenance");
  return { stopTaskRegistryMaintenance: vi.fn() };
});
vi.mock("../agents/main-session-recovery/main-session-restart-recovery.js", () => {
  state.loaded.push("restart-recovery");
  return { markRestartAbortedMainSessions: vi.fn() };
});
vi.mock("../agents/agent-bundle-lsp-runtime.js", () => {
  state.loaded.push("bundle-lsp");
  return { disposeAllBundleLspRuntimes: vi.fn() };
});
vi.mock("./embeddings-http.js", () => {
  throw new Error("shutdown preparation must not load embeddings HTTP");
});
vi.mock("./embeddings-provider-lifetime.js", () => {
  state.loaded.push("embeddings");
  return { drainRetainedOpenAiEmbeddingProviders: state.drainEmbeddingProviders };
});
vi.mock("../hooks/gmail-watcher.js", () => {
  state.loaded.push("gmail-watcher");
  return { stopGmailWatcher: vi.fn() };
});
vi.mock("../agents/code-mode-state.js", () => {
  state.loaded.push("code-mode");
  return { disposeAllCodeModeRuns: vi.fn() };
});
vi.mock("../agents/provider-transport-dispatcher-pool.js", () => {
  state.loaded.push("provider-transports");
  return { closeProviderTransportDispatcherPool: vi.fn() };
});
vi.mock("../plugins/runtime.js", () => {
  state.loaded.push("plugin-runtime");
  return {
    prepareActivePluginRegistryShutdown: state.preparePluginRegistryShutdown,
  };
});
vi.mock("../plugins/plugin-cache.js", () => {
  state.loaded.push("plugin-cache");
  return {
    get waitForPluginCacheRetirement() {
      if (!state.artifactsAvailable) {
        throw new Error("installed plugin-cache chunk was removed");
      }
      return state.waitForPluginCacheRetirement;
    },
  };
});

const { prepareGatewayShutdownRuntime } = await import("./server-shutdown.runtime.js");

describe("gateway shutdown runtime", () => {
  it("resolves every shutdown dependency during preparation", async () => {
    const runtime = await prepareGatewayShutdownRuntime();

    expect(state.loaded.toSorted()).toEqual(
      [
        "server-close",
        "plugin-hooks",
        "session-change-events",
        "session-event-publications",
        "mcp-http",
        "task-maintenance",
        "restart-recovery",
        "bundle-lsp",
        "embeddings",
        "gmail-watcher",
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
});
