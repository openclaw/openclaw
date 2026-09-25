import type { ApplicationGateway } from "./gateway.ts";
import type {
  InAppNotificationsCapability,
  InAppNotificationsSnapshot,
} from "./in-app-notifications.ts";

/** Keep the optional completion-notice preference off the initial Control UI bundle. */
export function createLazyInAppNotificationsCapability(
  gateway: ApplicationGateway,
): InAppNotificationsCapability {
  const snapshot: InAppNotificationsSnapshot = {
    enabled: false,
    loading: true,
    available: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  let capability: InAppNotificationsCapability | null = null;
  let stopCapability: (() => void) | null = null;
  let disposed = false;
  const publish = () => {
    if (capability) {
      Object.assign(snapshot, capability.snapshot);
    }
    for (const listener of listeners) {
      listener();
    }
  };
  void import("./in-app-notifications.ts")
    .then(({ createInAppNotificationsCapability }) => {
      if (disposed) {
        return;
      }
      capability = createInAppNotificationsCapability(gateway);
      stopCapability = capability.subscribe(publish);
      publish();
    })
    .catch((error: unknown) => {
      if (!disposed) {
        snapshot.loading = false;
        snapshot.error = String(error);
        publish();
      }
    });
  return {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setEnabled(enabled) {
      await capability?.setEnabled(enabled);
    },
    dispose() {
      disposed = true;
      stopCapability?.();
      capability?.dispose();
      listeners.clear();
    },
  };
}
