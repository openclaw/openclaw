import { sleepWithAbort } from "@openclaw/retry";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UpdateCampaignController } from "./update-campaign.js";
import type { resolveStartupInstallStatus } from "./update-install-status.js";

export type UpdateCheckLifecycle = {
  signal: AbortSignal;
  campaign?: Pick<UpdateCampaignController, "clear">;
  isCurrent: () => boolean;
  refreshes: WeakMap<OpenClawConfig, Promise<void>>;
  run: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  initialize: () => ReturnType<typeof resolveStartupInstallStatus>;
  schedule: (work: () => Promise<number>, unref?: boolean) => void;
  stop: () => Promise<void>;
};
let updateCheckLifecycle: UpdateCheckLifecycle | undefined;

export function createGatewayUpdateLifecycle(): UpdateCheckLifecycle {
  const predecessor = updateCheckLifecycle?.stop();
  const controller = new AbortController();
  const { signal } = controller;
  const pending = new Set<Promise<unknown>>();
  let initialization: ReturnType<typeof resolveStartupInstallStatus> | undefined;
  let stopping: Promise<void> | undefined;

  const run = <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const task = (async () => {
      await predecessor;
      signal.throwIfAborted();
      return await work(signal);
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
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
  const schedule = (work: () => Promise<number>, unref = false) => {
    void run(async () => {
      while (!signal.aborted) {
        const delayMs = await work();
        await sleepWithAbort(Math.max(1, delayMs), signal, { ref: !unref });
      }
    }).catch(() => undefined);
  };
  const lifecycle: UpdateCheckLifecycle = {
    signal,
    isCurrent: () => updateCheckLifecycle === lifecycle,
    refreshes: new WeakMap(),
    run,
    initialize,
    schedule,
    stop: () => {
      controller.abort();
      if (updateCheckLifecycle === lifecycle) {
        lifecycle.campaign?.clear();
      }
      // Replacement owns the predecessor's drain too. Aborting alone does not
      // join a Git transport or maintenance process that is still shutting down.
      return (stopping ??= Promise.allSettled([predecessor, ...pending]).then(() => undefined));
    },
  };
  updateCheckLifecycle = lifecycle;
  return lifecycle;
}

export function currentUpdateCheckLifecycle() {
  return updateCheckLifecycle ?? createGatewayUpdateLifecycle();
}
