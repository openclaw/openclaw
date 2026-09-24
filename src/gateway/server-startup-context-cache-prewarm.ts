import { clearContextWindowCaches } from "../agents/context-cache.js";
import { beginContextWindowCacheRefresh } from "../agents/context-runtime-state.js";
import { registerPreparedModelRuntimePublicationListener } from "../agents/prepared-model-runtime.publication-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { scheduleGatewayIdleTask, type GatewayIdleTaskHandle } from "./server-idle-task.js";

const CONTEXT_CACHE_PREWARM_START_DELAY_MS = 5_000;
const CONTEXT_CACHE_PREWARM_RETRY_DELAY_MS = 250;

type StartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

export function scheduleContextCachePrewarm(params: {
  getConfig: () => OpenClawConfig;
  startupTrace?: StartupTrace;
  log: { warn: (msg: string) => void };
}): GatewayIdleTaskHandle {
  let stopped = false;
  const warm = async () => {
    if (stopped) {
      return;
    }
    const { prewarmContextWindowCacheAfterReady } = await import("../agents/context.js");
    if (!stopped) {
      await prewarmContextWindowCacheAfterReady({
        config: params.getConfig(),
        isCancelled: () => stopped,
      });
    }
  };

  // Source-backed provider discovery can consume the main thread. Give
  // readiness probes and immediate client work a clean event-loop window.
  const idleTask = scheduleGatewayIdleTask({
    delayMs: CONTEXT_CACHE_PREWARM_START_DELAY_MS,
    retryDelayMs: CONTEXT_CACHE_PREWARM_RETRY_DELAY_MS,
    isClosing: () => stopped,
    isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
    run: () =>
      params.startupTrace
        ? params.startupTrace.measure("post-ready.context-window-cache", warm)
        : warm(),
    log: params.log,
    errorMessage: "post-ready.context-window-cache failed after gateway ready",
  });

  // Reuse the existing idle-work admission and lifetime; a publisher's temporary
  // startup/auth scope must not own this asynchronous projection. Bursts coalesce
  // into one task, whose zero-delay pass reads the newest accepted publication.
  let publicationTask: GatewayIdleTaskHandle | undefined;
  let publicationVersion = 0;
  const unregister = registerPreparedModelRuntimePublicationListener((event) => {
    if (!stopped && event.phase === "invalidated" && event.modelFactsChanged !== false) {
      beginContextWindowCacheRefresh();
      clearContextWindowCaches();
      return;
    }
    if (
      stopped ||
      (event.phase !== "catalog-published" && event.phase !== "published") ||
      event.modelFactsChanged === false
    ) {
      return;
    }
    publicationVersion += 1;
    if (publicationTask) {
      return;
    }
    publicationTask = scheduleGatewayIdleTask({
      delayMs: 0,
      retryDelayMs: CONTEXT_CACHE_PREWARM_RETRY_DELAY_MS,
      isClosing: () => stopped,
      isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
      run: async () => {
        try {
          let version: number;
          do {
            version = publicationVersion;
            await warm();
            if (stopped) {
              break;
            }
          } while (version !== publicationVersion);
        } finally {
          publicationTask = undefined;
        }
      },
      log: params.log,
      errorMessage: "published context-window-cache refresh failed",
    });
  });

  return {
    stop: () => {
      stopped = true;
      unregister();
      return Promise.all([idleTask.stop(), publicationTask?.stop()]).then(() => {});
    },
  };
}
