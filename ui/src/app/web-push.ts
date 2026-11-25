import { isIosBrowserPlatform } from "../lib/browser-platform.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readWebPushAccess, type WebPushAccess } from "./web-push-access.ts";
import type {
  WebPushCapabilityAction,
  WebPushCapabilityPatch,
  WebPushCapabilityRuntime,
  WebPushPreferencesResult,
  WebPushSubscriptionState,
} from "./web-push.runtime.ts";

export type WebPushSnapshot = WebPushAccess & {
  supported: boolean;
  permission: NotificationPermission | "install-required" | "unsupported";
  subscription: WebPushSubscriptionState;
  loading: boolean;
  read?: Promise<unknown>;
  command?: Promise<void>;
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
  let owner: WebPushCapabilityRuntime | undefined;
  const snapshot: WebPushSnapshot = {
    supported,
    ...readWebPushAccess(gateway.snapshot),
    permission: installed
      ? supported
        ? Notification.permission
        : "unsupported"
      : "install-required",
    subscription: "unknown",
    get loading() {
      return owner?.pending ?? false;
    },
  };
  let render: (() => void) | undefined;

  const publish = (patch: WebPushCapabilityPatch) => {
    Object.assign(snapshot, patch);
    render?.();
  };
  const stopGateway = gateway.subscribe((next) => {
    const access = readWebPushAccess(next);
    if (
      access.canManage !== snapshot.canManage ||
      access.canReadPreferences !== snapshot.canReadPreferences
    ) {
      publish(access);
    }
  });
  const initialization = supported
    ? import("./web-push.runtime.ts").then(
        ({ createWebPushCapabilityRuntime }) =>
          (owner = createWebPushCapabilityRuntime({
            gateway,
            publish,
            connectionBootstrap: options.connectionBootstrap,
          })),
      )
    : undefined;
  const runtime = initialization?.catch(() => {
    publish({
      supported: false,
      permission: "unsupported",
      subscription: "unknown",
      preferences: null,
      read: initialization,
    });
    return null;
  });
  return {
    snapshot,
    subscribe(listener: () => void) {
      render = listener;
      return () => {
        render = undefined;
      };
    },
    run: (action: WebPushCapabilityAction) =>
      runtime ? runtime.then((runtimeOwner) => runtimeOwner?.run(action)) : Promise.resolve(),
    dispose(this: void) {
      stopGateway();
      void runtime?.then((runtimeOwner) => runtimeOwner?.dispose());
      render = undefined;
    },
  };
}
