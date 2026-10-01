import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { LiveActivityStore } from "../infra/push-live-activity-store.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";

export function createLiveActivityCoordinator(params: {
  gatewayIdentity: DeviceIdentity;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  getRuntimeConfig: () => OpenClawConfig;
  log: Pick<SubsystemLogger, "warn">;
}) {
  const store = new LiveActivityStore();
  let closing = false;
  let closed = false;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const wake = () => {
    if (closing || closed || scheduled) {
      return;
    }
    clearTimer();
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closing || closed) {
        return;
      }
      try {
        pump();
      } catch {
        params.log.warn("Live Activity maintenance failed");
      }
    });
  };
  const pump = () => {
    clearTimer();
    store.sweep();
    const next = store.nextMaintenanceAtMs();
    if (next !== null && !closing) {
      timer = setTimeout(wake, Math.max(1, next - Date.now()));
      timer.unref?.();
    }
  };
  const beginClose = () => {
    closing = true;
    clearTimer();
  };
  const stop = () =>
    (stopping ??= (async () => {
      beginClose();
      closed = true;
      store.close();
    })());

  wake();
  return { beginClose, stop };
}

export type LiveActivityCoordinator = ReturnType<typeof createLiveActivityCoordinator>;
