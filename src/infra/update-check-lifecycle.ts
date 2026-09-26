import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { GatewayScheduler, GatewayScheduledJob } from "./gateway-scheduler.js";
import type { UpdateCampaignController } from "./update-campaign.js";
import type { resolveStartupInstallStatus } from "./update-install-status.js";

export type UpdateCheckLifecycle = {
  signal: AbortSignal;
  campaign?: Pick<UpdateCampaignController, "clear">;
  isCurrent: () => boolean;
  refreshes: WeakMap<OpenClawConfig, Promise<void>>;
  run: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  initialize: () => ReturnType<typeof resolveStartupInstallStatus>;
  schedule: (id: string, work: () => Promise<number>) => void;
  stop: () => Promise<void>;
};
let updateCheckLifecycle: UpdateCheckLifecycle | undefined;

export function createGatewayUpdateLifecycle(scheduler: GatewayScheduler): UpdateCheckLifecycle {
  const predecessor = updateCheckLifecycle?.stop();
  const scope = new AsyncWorkScope();
  const { signal } = scope;
  const jobs = new Map<string, GatewayScheduledJob>();
  let initialization: ReturnType<typeof resolveStartupInstallStatus> | undefined;
  let stopping: Promise<void> | undefined;

  const run = <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    scope.track(async () => {
      await predecessor;
      signal.throwIfAborted();
      return await work(signal);
    });
  const initialize = async () => {
    signal.throwIfAborted();
    if (!initialization) {
      const task = run(async () => {
        const { resolveStartupInstallStatus } = await import("./update-install-status.js");
        signal.throwIfAborted();
        return resolveStartupInstallStatus(false, signal);
      });
      initialization = task;
      void task.catch(() => {
        if (initialization === task) {
          initialization = undefined;
        }
      });
    }
    return initialization;
  };
  const schedule = (id: string, work: () => Promise<number>) => {
    const arm = (delayMs: number) => {
      if (signal.aborted) {
        return;
      }
      jobs.set(
        id,
        scheduler.schedule({
          id,
          delayMs,
          run: () =>
            run(work)
              .then((nextDelayMs) => arm(Math.max(1, nextDelayMs)))
              .catch(() => undefined),
        }),
      );
    };
    arm(0);
  };
  const lifecycle: UpdateCheckLifecycle = {
    signal,
    isCurrent: () => updateCheckLifecycle === lifecycle,
    refreshes: new WeakMap(),
    run,
    initialize,
    schedule,
    stop: () => {
      scope.beginClose();
      for (const job of jobs.values()) {
        job.cancel();
      }
      jobs.clear();
      if (updateCheckLifecycle === lifecycle) {
        lifecycle.campaign?.clear();
      }
      // Replacement owns the predecessor's drain too. Aborting alone does not
      // join a Git transport or maintenance process that is still shutting down.
      return (stopping ??= Promise.allSettled([predecessor, scope.drain()]).then(() => undefined));
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
