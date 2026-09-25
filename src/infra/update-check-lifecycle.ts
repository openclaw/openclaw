import { sleepWithAbort } from "@openclaw/retry";
import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UpdateCampaignController } from "./update-campaign.js";
import type { resolveStartupInstallStatus } from "./update-install-status.js";

type UpdateCheckNotifications = {
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
  onUpdateScheduleChange?: (schedule: UpdateScheduleState) => void;
};

export type UpdateCheckLifecycle = UpdateCheckNotifications & {
  signal: AbortSignal;
  campaign?: Pick<UpdateCampaignController, "clear">;
  isCurrent: () => boolean;
  /** Shared publication order for background and interactive Dev discovery. */
  devGitCheckGeneration: number;
  refreshes: WeakMap<OpenClawConfig, Promise<void>>;
  run: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  initialize: () => ReturnType<typeof resolveStartupInstallStatus>;
  schedule: (work: () => Promise<number>, unref?: boolean) => void;
  stop: () => Promise<void>;
};
let updateCheckLifecycle: UpdateCheckLifecycle | undefined;

export function createGatewayUpdateLifecycle(
  notifications: UpdateCheckNotifications = {},
): UpdateCheckLifecycle {
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
    ...notifications,
    signal,
    isCurrent: () => updateCheckLifecycle === lifecycle,
    devGitCheckGeneration: 0,
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
