import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createGatewayUpdateLifecycle } from "../infra/update-check-lifecycle.js";
import type { createGatewayUpdateCheck } from "../infra/update-startup.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import {
  canReadDetailedUpdateMetadata,
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  projectUpdateAvailable,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";
import { startUpdateRunWatcher, wakeUpdateRunWatcher } from "./update-run-watcher.js";

export function createDeferredGatewayUpdateCheck(params: {
  scheduler: GatewayScheduler;
  startupTrace?: GatewayStartupTrace;
  createUpdateCheck: (
    ...args: Parameters<typeof createGatewayUpdateCheck>
  ) =>
    | ReturnType<typeof createGatewayUpdateCheck>
    | Promise<ReturnType<typeof createGatewayUpdateCheck>>;
  getConfig: () => OpenClawConfig;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  isNixMode: boolean;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  getClientConnIds: (filter?: (client: GatewayClient) => boolean) => ReadonlySet<string>;
  waitForPostReadyWork?: () => Promise<void>;
  isClosing?: () => boolean;
  activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
}): { start: () => void; stop: () => Promise<void> } {
  // Reserve cancellation before an early RPC can start install discovery.
  const lifecycle = createGatewayUpdateLifecycle(params.scheduler);
  let stopped = false;
  let started = false;
  let runWatcher: ReturnType<typeof startUpdateRunWatcher> | undefined;
  let owner: ReturnType<typeof createGatewayUpdateCheck> | undefined;
  let ownerReady: Promise<void> | undefined;
  let initialization: Promise<unknown> | undefined;
  let stopPromise: Promise<void> | undefined;
  let latestUpdateAvailable: GatewayUpdateAvailableEventPayload["updateAvailable"] = null;
  let latestSchedule: GatewayUpdateAvailableEventPayload["schedule"];

  const broadcastUpdateAvailable = (payload: GatewayUpdateAvailableEventPayload) => {
    if (stopped || params.isClosing?.()) {
      return;
    }
    const detailedConnIds = params.getClientConnIds((client) =>
      canReadDetailedUpdateMetadata(client.connect.role ?? "operator", client.connect.scopes ?? []),
    );
    const legacyConnIds = new Set(params.getClientConnIds());
    for (const connId of detailedConnIds) {
      legacyConnIds.delete(connId);
    }
    params.broadcastToConnIds(GATEWAY_EVENT_UPDATE_AVAILABLE, payload, detailedConnIds, {
      dropIfSlow: true,
    });
    params.broadcastToConnIds(
      GATEWAY_EVENT_UPDATE_AVAILABLE,
      { updateAvailable: projectUpdateAvailable(payload.updateAvailable, false) ?? null },
      legacyConnIds,
      { dropIfSlow: true },
    );
  };

  const stop = () => {
    stopped = true;
    return (stopPromise ??= (async () => {
      // Fence immediately; a lazy factory that finishes later stops its own
      // owner below. Never join the post-ready barrier during failed startup.
      const cleanup = Promise.all([lifecycle.stop(), runWatcher?.stop(), owner?.stop()]);
      await ownerReady;
      await cleanup;
      await initialization;
    })());
  };

  const start = () => {
    if (started || stopped) {
      return;
    }
    started = true;
    runWatcher = startUpdateRunWatcher({
      broadcast: (event, payload) =>
        params.broadcastToConnIds(event, payload, params.getClientConnIds()),
      log: params.log,
    });
    void (async () => {
      if (params.waitForPostReadyWork) {
        await params.waitForPostReadyWork();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      if (stopped || params.isClosing?.()) {
        return;
      }
      ownerReady = (async () => {
        try {
          owner = await params.createUpdateCheck({
            lifecycle,
            getConfig: params.getConfig,
            onUpdateRunCreated: wakeUpdateRunWatcher,
            log: params.log,
            isNixMode: params.isNixMode,
            ...(params.activeWorkInspectors
              ? { activeWorkInspectors: params.activeWorkInspectors }
              : {}),
            onUpdateAvailableChange: (updateAvailable) => {
              latestUpdateAvailable = updateAvailable;
              const payload: GatewayUpdateAvailableEventPayload = {
                updateAvailable,
                ...(latestSchedule ? { schedule: latestSchedule } : {}),
              };
              broadcastUpdateAvailable(payload);
            },
            onUpdateScheduleChange: (schedule) => {
              latestSchedule = schedule;
              const payload: GatewayUpdateAvailableEventPayload = {
                updateAvailable: latestUpdateAvailable,
                schedule,
              };
              broadcastUpdateAvailable(payload);
            },
          });
        } catch (err) {
          if (!stopped) {
            params.log.warn(`gateway update check failed to initialize: ${String(err)}`);
          }
          return;
        }
        if (stopped || params.isClosing?.()) {
          await owner.stop();
          return;
        }
        const updateCheck = owner;
        initialization = (async () => updateCheck.initialize())().catch((err: unknown) => {
          if (!stopped) {
            params.log.warn(`gateway update status failed to initialize: ${String(err)}`);
          }
        });
      })();
      await ownerReady;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (!stopped && !params.isClosing?.()) {
        await runWithGatewayIndependentRootWorkAdmission(async () => {
          if (stopped || params.isClosing?.()) {
            return;
          }
          await measureStartup(params.startupTrace, "post-attach.update-check", () =>
            owner?.start(),
          );
        }, "startup:update-check");
      }
    })().catch((err: unknown) => {
      if (!stopped) {
        params.log.warn(`gateway update check readiness wait failed: ${String(err)}`);
      }
    });
  };

  return { start, stop };
}
