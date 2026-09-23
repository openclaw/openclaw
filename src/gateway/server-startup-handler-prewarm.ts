import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { scheduleGatewayIdleTask, type GatewayIdleTaskHandle } from "./server-idle-task.js";

const GATEWAY_HANDLER_PREWARM_RETRY_DELAY_MS = 250;

type StartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

type GatewayHandlerPrewarmItem = {
  name: string;
  load: () => Promise<unknown>;
};

function dashboardDataPrewarmItems(cfg: OpenClawConfig): GatewayHandlerPrewarmItem[] {
  return [
    {
      name: "plugins",
      load: async () => {
        const { listManagedPlugins } = await import("../plugins/management-service.js");
        await listManagedPlugins({ config: cfg });
      },
    },
  ];
}

export function scheduleGatewayHandlerPrewarm(params: {
  cfgAtStart: OpenClawConfig;
  startupTrace?: StartupTrace;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
  items?: readonly GatewayHandlerPrewarmItem[];
  waitForPostReadyWork?: () => Promise<void>;
}): GatewayIdleTaskHandle {
  // Session rows are resident; only process-stable plugin data needs optional prewarm.
  // Provider catalogs stay request-driven because their adapters may do unbounded external work.
  const items = params.items ?? dashboardDataPrewarmItems(params.cfgAtStart);
  let stopped = false;
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
        delayMs: 0,
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
