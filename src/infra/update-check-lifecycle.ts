import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { GatewayScheduler } from "./gateway-scheduler.js";
import type { UpdateCampaignController } from "./update-campaign.js";
import type { StartupInstallStatus } from "./update-install-status.types.js";

type UpdateCheckNotifications = {
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
  onUpdateScheduleChange?: (schedule: UpdateScheduleState) => void;
};

export type UpdateCheckLifecycle = UpdateCheckNotifications & {
  scheduler: GatewayScheduler;
  signal: AbortSignal;
  campaign?: UpdateCampaignController;
  installStatus?: StartupInstallStatus;
  /** Background owner policy admits the first campaign from an interactive result. */
  announceDevGitUpdate?: (
    target: Extract<NonNullable<UpdateScheduleState["target"]>, { kind: "git" }>,
    installStatus: StartupInstallStatus,
  ) => Promise<void>;
  isCurrent: () => boolean;
  refreshes: WeakMap<OpenClawConfig, Promise<void>>;
  run: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  initialize: () => Promise<StartupInstallStatus>;
  schedule: (id: string, work: () => Promise<number>) => void;
  stop: () => Promise<void>;
};
let updateCheckLifecycle: UpdateCheckLifecycle | undefined;

export function createGatewayUpdateLifecycle(
  scheduler: GatewayScheduler,
  notifications: UpdateCheckNotifications = {},
): UpdateCheckLifecycle {
  const predecessor = updateCheckLifecycle?.stop();
  const scope = new AsyncWorkScope();
  const scheduled = scheduler.scope();
  const { signal } = scheduled;
  let initialization: Promise<StartupInstallStatus> | undefined;
  let stopping: Promise<void> | undefined;

  const run = <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    scope.track(async () => {
      await predecessor;
      signal.throwIfAborted();
      return await work(signal);
    });
  const initialize = async () => {
    signal.throwIfAborted();
    if (lifecycle.installStatus && !lifecycle.installStatus.status.error) {
      return lifecycle.installStatus;
    }
    if (!initialization) {
      const task = run(async () => {
        const { resolveStartupInstallStatus } = await import("./update-install-status.js");
        signal.throwIfAborted();
        const result = await resolveStartupInstallStatus(false, signal);
        signal.throwIfAborted();
        // A fresh interactive probe may have already adopted the installation.
        if (!lifecycle.installStatus || lifecycle.installStatus.status.error) {
          lifecycle.installStatus = result;
        }
        return lifecycle.installStatus;
      });
      initialization = task;
      const clearInitialization = () => {
        if (initialization === task) {
          initialization = undefined;
        }
      };
      void task.then(clearInitialization, clearInitialization);
    }
    return initialization;
  };
  const schedule = (id: string, work: () => Promise<number>) => {
    const arm = (delayMs: number) => {
      if (signal.aborted) {
        return;
      }
      scheduled.schedule({
        id,
        delayMs,
        run: () =>
          run(work)
            .then((nextDelayMs) => arm(Math.max(1, nextDelayMs)))
            .catch((error: unknown) => {
              if (!signal.aborted) {
                throw error;
              }
            }),
      });
    };
    arm(0);
  };
  const lifecycle: UpdateCheckLifecycle = {
    scheduler,
    ...notifications,
    signal,
    isCurrent: () => updateCheckLifecycle === lifecycle,
    refreshes: new WeakMap(),
    run,
    initialize,
    schedule,
    stop: () => {
      scope.beginClose();
      scheduled.beginClose();
      lifecycle.campaign?.clear();
      // Replacement owns the predecessor's drain too. Aborting alone does not
      // join a Git transport or maintenance process that is still shutting down.
      return (stopping ??= Promise.allSettled([predecessor, scope.drain(), scheduled.stop()]).then(
        () => undefined,
      ));
    },
  };
  updateCheckLifecycle = lifecycle;
  return lifecycle;
}

export function currentUpdateCheckLifecycle() {
  if (!updateCheckLifecycle) {
    throw new Error("Gateway update lifecycle is not initialized");
  }
  return updateCheckLifecycle;
}
