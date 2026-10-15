import { registerListener } from "../../../src/shared/listeners.js";
import { isIosBrowserPlatform } from "../lib/browser-platform.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type {
  WebPushCapabilityAction,
  WebPushCapabilityPatch,
  WebPushCapabilityRuntime,
  WebPushPreferencesResult,
  WebPushSubscriptionState,
} from "./web-push.runtime.ts";

export type WebPushSnapshot = {
  supported: boolean;
  permission: NotificationPermission | "install-required" | "unsupported";
  subscription: WebPushSubscriptionState;
  loading: boolean;
  error?: string | null;
  preferences?: WebPushPreferencesResult | null;
};

export type WebPushCapability = ReturnType<typeof createWebPushCapability>;

export function createWebPushCapability(
  gateway: ApplicationGateway,
  options: { connectionBootstrap?: ConnectionBootstrapCoordinator } = {},
) {
  const nav = globalThis.navigator;
  const ios = isIosBrowserPlatform();
  // SAFETY: iOS Safari's non-standard standalone flag is optional and read-only.
  const installed = !ios || (nav as Navigator & { standalone?: boolean }).standalone === true;
  const supported =
    installed &&
    "serviceWorker" in nav &&
    "PushManager" in globalThis &&
    "Notification" in globalThis;
  const snapshot: WebPushSnapshot = {
    supported,
    permission: installed
      ? supported
        ? Notification.permission
        : "unsupported"
      : "install-required",
    subscription: "unknown",
    loading: false,
  };
  const listeners = new Set<() => void>();

  const publish = (patch: WebPushCapabilityPatch) => {
    Object.assign(snapshot, patch);
    for (const listener of listeners) {
      listener();
    }
  };
  const runtime: Promise<WebPushCapabilityRuntime | null> | null = snapshot.supported
    ? import("./web-push.runtime.ts")
        .then(({ createWebPushCapabilityRuntime }) =>
          createWebPushCapabilityRuntime({
            gateway,
            publish,
            connectionBootstrap: options.connectionBootstrap,
          }),
        )
        .catch((error: unknown) => {
          publish({
            supported: false,
            permission: "unsupported",
            subscription: "unknown",
            preferences: null,
            error: formatUiError(error),
          });
          return null;
        })
    : null;
  return {
    snapshot,
    subscribe: (listener: () => void) => registerListener(listeners, listener),
    run: (action: WebPushCapabilityAction) =>
      runtime ? runtime.then((owner) => owner?.run(action)) : Promise.resolve(),
    dispose(this: void) {
      void runtime?.then((owner) => owner?.dispose());
      listeners.clear();
    },
  };
}
