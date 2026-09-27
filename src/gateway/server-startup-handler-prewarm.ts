import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { scheduleGatewayIdleTask, type GatewayIdleTaskHandle } from "./server-idle-task.js";

const GATEWAY_HANDLER_PREWARM_RETRY_DELAY_MS = 250;

type StartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

type GatewayHandlerPrewarmItem = {
  name: string;
  notBeforeMs?: number;
  load: () => Promise<unknown>;
};

function gatewayPrewarmItems(
  getConfig: () => OpenClawConfig,
  isCancelled: () => boolean,
): GatewayHandlerPrewarmItem[] {
  return [
    { name: "connection", load: () => import("./server/ws-connection/message-handler.js") },
    ...["chat.history", "chat.send", "sessions.list"].map((method) => ({
      name: method,
      load: async () => {
        const [{ coreGatewayHandlers }, { prepareGatewayRequestHandler }] = await Promise.all([
          import("./server-methods/core-handlers.js"),
          import("./server-methods/lazy-core-handlers.js"),
        ]);
        if (!isCancelled()) {
          const handler = coreGatewayHandlers[method];
          if (!handler) {
            throw new Error(`Gateway prewarm handler not found: ${method}`);
          }
          await prepareGatewayRequestHandler(handler);
        }
      },
    })),
    { name: "agent-events", load: () => import("./server-chat.js") },
    { name: "session-key", load: () => import("./server-session-key.js") },
    ...listAgentIds(getConfig()).map((agentId) => ({
      name: `skills.${agentId}`,
      load: async () => {
        const [
          { prepareWorkspaceSkillEntries },
          { getAgentWorkspaceAccess },
          { ensureSkillsWatcher },
        ] = await Promise.all([
          import("../skills/loading/workspace-skill-loader.js"),
          import("../agents/workspace-access.js"),
          import("../skills/runtime/refresh.js"),
        ]);
        const config = getConfig();
        if (isCancelled() || !listAgentIds(config).includes(agentId)) {
          return;
        }
        const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
        // Remote workspaces retain request-owned discovery and connection lifetimes.
        if (!getAgentWorkspaceAccess(workspaceDir, "loadSkills")) {
          ensureSkillsWatcher({ workspaceDir, config, agentId });
          await prepareWorkspaceSkillEntries(workspaceDir, { config, agentId });
        }
      },
    })),
    {
      name: "context-window-cache",
      notBeforeMs: 5_000,
      load: async () => {
        const { prewarmContextWindowCacheAfterReady } = await import("../agents/context.js");
        if (!isCancelled()) {
          await prewarmContextWindowCacheAfterReady({ config: getConfig(), isCancelled });
        }
      },
    },
    {
      name: "memory-search",
      load: async () => {
        const { getMemoryCapabilityRegistration } = await import("../plugins/memory-state.js");
        if (isCancelled() || getMemoryCapabilityRegistration()?.pluginId !== "memory-core") {
          return;
        }
        const { loadBundledPluginPublicArtifactModuleSync } =
          await import("../plugins/public-surface-loader.js");
        if (isCancelled()) {
          return;
        }
        const { prewarmMemorySearchWorker } = loadBundledPluginPublicArtifactModuleSync<{
          prewarmMemorySearchWorker: () => Promise<void>;
        }>({ dirName: "memory-core", artifactBasename: "prewarm-api.js" });
        await prewarmMemorySearchWorker();
      },
    },
    {
      name: "plugins",
      load: async () => {
        const { listManagedPlugins } = await import("../plugins/management-service.js");
        if (!isCancelled()) {
          await listManagedPlugins({ config: getConfig() });
        }
      },
    },
  ];
}

export function scheduleGatewayHandlerPrewarm(params: {
  scheduler: GatewayScheduler;
  getConfig: () => OpenClawConfig;
  startupTrace?: StartupTrace;
  log: { warn: (msg: string) => void };
  items?: readonly GatewayHandlerPrewarmItem[];
  waitForPostReadyWork?: () => Promise<void>;
}): GatewayIdleTaskHandle {
  let stopped = false;
  const startedAt = params.scheduler.now();
  // Warm code and local facts without executing requests or acquiring live provider catalogs.
  const items =
    params.items ??
    gatewayPrewarmItems(
      params.getConfig,
      () => stopped || getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
    );
  let nextIndex = 0;
  let currentItemName = "unknown";
  let idleTask: GatewayIdleTaskHandle | undefined;

  const scheduleNext = () => {
    if (stopped || nextIndex >= items.length) {
      return;
    }
    void (async () => {
      await params.waitForPostReadyWork?.();
      if (stopped) {
        return;
      }
      const item = items[nextIndex++];
      if (!item) {
        return;
      }
      currentItemName = item.name;
      const load = () => item.load();
      idleTask = scheduleGatewayIdleTask({
        id: "startup:handler-prewarm",
        scheduler: params.scheduler,
        delayMs: Math.max(0, (item.notBeforeMs ?? 0) - (params.scheduler.now() - startedAt)),
        retryDelayMs: GATEWAY_HANDLER_PREWARM_RETRY_DELAY_MS,
        isClosing: () => stopped,
        isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
        run: async () => {
          try {
            await (params.startupTrace
              ? params.startupTrace.measure(`post-ready.gateway-data.${item.name}`, load)
              : load());
          } finally {
            // Keep the outgoing join published until its lease and warning handler settle.
            void Promise.resolve(idleTask?.stop()).then(scheduleNext, scheduleNext);
          }
        },
        log: params.log,
        // Prewarm only improves latency; readiness and request-time loaders remain authoritative.
        errorMessage: `post-ready gateway data prewarm failed for ${item.name}`,
      });
    })().catch((err: unknown) => {
      params.log.warn(
        `post-ready gateway data prewarm failed for ${currentItemName}: ${String(err)}`,
      );
      scheduleNext();
    });
  };

  // One cache fill per event-loop turn lets immediate client work run between steps.
  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      return idleTask?.stop();
    },
  };
}
