import { registerListener } from "../../../src/shared/listeners.js";
import { webKitHostWindow } from "./native-webkit-bridge.ts";

export type NativeNotificationsPermission = "granted" | "denied" | "notDetermined";

type NativeNotificationTestOutcome =
  | { state: "pending" }
  | { state: "sent" }
  | { state: "error"; message: string };

type NativeNotificationsSnapshot = {
  permission: NativeNotificationsPermission | "unknown";
  test: NativeNotificationTestOutcome | null;
};

type NativeBackgroundSessionCompletion = {
  runId: string;
  path: string;
  search?: string;
};

type NativeNotificationsWindow = Window & {
  __OPENCLAW_NATIVE_NOTIFICATIONS__?: unknown;
};

// Wire contract with the Mac app's dashboard bridge (DashboardWindowController+Notifications.swift).
const NATIVE_NOTIFICATIONS_STATUS_EVENT = "openclaw:native-notifications-status";

export type NativeNotificationsCapability = NonNullable<
  ReturnType<typeof createNativeNotificationsCapability>
>;

function isNativeNotificationsPermission(value: unknown): value is NativeNotificationsPermission {
  return value === "granted" || value === "denied" || value === "notDetermined";
}

function snapshotFrom(value: unknown): NativeNotificationsSnapshot | null {
  if (typeof value !== "object" || value === null || !("permission" in value)) {
    return null;
  }
  if (!isNativeNotificationsPermission(value.permission)) {
    return null;
  }
  if (!("test" in value) || value.test === null) {
    return { permission: value.permission, test: null };
  }
  const test = value.test;
  if (typeof test !== "object" || test === null || !("state" in test)) {
    return null;
  }
  if (test.state === "pending" || test.state === "sent") {
    return { permission: value.permission, test: { state: test.state } };
  }
  if (test.state === "error" && "message" in test && typeof test.message === "string") {
    return { permission: value.permission, test: { state: "error", message: test.message } };
  }
  return null;
}

export function createNativeNotificationsCapability() {
  const handler = webKitHostWindow()?.webkit?.messageHandlers?.openclawNotifications;
  const postMessage = handler?.postMessage.bind(handler);
  if (!postMessage) {
    return null;
  }

  const nativeWindow = window as NativeNotificationsWindow;
  let snapshot = snapshotFrom(nativeWindow["__OPENCLAW_NATIVE_NOTIFICATIONS__"]) ?? {
    permission: "unknown" as const,
    test: null,
  };
  const listeners = new Set<(snapshot: NativeNotificationsSnapshot) => void>();

  const publish = (next: NativeNotificationsSnapshot) => {
    snapshot = next;
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
  const handleStatus = (event: Event) => {
    const next = snapshotFrom((event as CustomEvent<unknown>).detail);
    if (next) {
      publish(next);
    }
  };
  // Permission may change in System Settings while the app is backgrounded.
  const refreshStatus = () => postMessage({ type: "status" });

  window.addEventListener(NATIVE_NOTIFICATIONS_STATUS_EVENT, handleStatus);
  window.addEventListener("focus", refreshStatus);
  refreshStatus();

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe: (listener: (snapshot: NativeNotificationsSnapshot) => void) =>
      registerListener(listeners, listener),
    requestPermission(this: void) {
      postMessage({ type: "request-permission" });
    },
    sendTest(this: void) {
      if (snapshot.test?.state === "pending") {
        return;
      }
      publish({ ...snapshot, test: { state: "pending" } });
      postMessage({ type: "send-test" });
    },
    backgroundSessionCompleted(this: void, completion: NativeBackgroundSessionCompletion) {
      postMessage({ type: "background-session-completed", ...completion });
    },
    dispose(this: void) {
      window.removeEventListener(NATIVE_NOTIFICATIONS_STATUS_EVENT, handleStatus);
      window.removeEventListener("focus", refreshStatus);
      listeners.clear();
    },
  };
}
