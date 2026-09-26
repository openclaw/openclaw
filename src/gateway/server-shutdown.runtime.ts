export async function prepareGatewayShutdownRuntime() {
  const [
    {
      prepareGatewayClose,
      completeGatewayClose,
      drainActiveSessionsForShutdown,
      runGatewayClosePrelude,
    },
    { runGlobalGatewayStopSafely },
    { flushPendingSessionsChangedEvents },
    { closeMcpLoopbackServer },
    { markRestartAbortedMainSessions },
    { disposeAllBundleLspRuntimes },
    { drainRetainedOpenAiEmbeddingProviders },
    { stopGmailWatcher },
    { stopCronMaintenance },
    { disposeAllCodeModeRuns },
    { closeProviderTransportDispatcherPool },
    { prepareActivePluginRegistryShutdown },
    { waitForPluginCacheRetirement },
  ] = await Promise.all([
    import("./server-close.runtime.js"),
    import("../plugins/hook-runner-global.js"),
    import("./server-methods/session-change-event.js"),
    import("./mcp-http.js"),
    import("../agents/main-session-recovery/main-session-restart-recovery.js"),
    import("../agents/agent-bundle-lsp-runtime.js"),
    import("./embeddings-provider-lifetime.js"),
    import("../hooks/gmail-watcher.js"),
    import("../cron/maintenance.js"),
    import("../agents/code-mode-state.js"),
    import("../agents/provider-transport-dispatcher-pool.js"),
    import("../plugins/runtime.js"),
    import("../plugins/plugin-cache.js"),
  ]);
  await prepareActivePluginRegistryShutdown();

  return {
    prepareGatewayClose,
    completeGatewayClose,
    drainActiveSessionsForShutdown,
    runGatewayClosePrelude,
    runGlobalGatewayStopSafely,
    flushPendingSessionsChangedEvents,
    closeMcpLoopbackServer,
    markRestartAbortedMainSessions,
    disposeAllBundleLspRuntimes,
    drainRetainedOpenAiEmbeddingProviders,
    stopGmailWatcher,
    stopCronMaintenance,
    disposeAllCodeModeRuns,
    closeProviderTransportDispatcherPool,
    waitForPluginCacheRetirement,
  };
}

export type GatewayShutdownRuntime = Awaited<ReturnType<typeof prepareGatewayShutdownRuntime>>;
