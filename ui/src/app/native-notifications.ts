import { listen } from "../lib/reactive/listener.ts";
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
  let render: ((snapshot: NativeNotificationsSnapshot) => void) | undefined;
  let testCompletion: PromiseWithResolvers<NativeNotificationTestOutcome | undefined> | undefined;
  let testAcknowledged = false;

  const publish = (next: NativeNotificationsSnapshot) => {
    snapshot = next;
    render?.(snapshot);
  };
  const handleStatus = (event: Event) => {
    const next = snapshotFrom((event as CustomEvent<unknown>).detail);
    if (next) {
      publish(next);
      if (next.test?.state === "pending") {
        testAcknowledged = true;
      } else if (next.test && testAcknowledged) {
        const completion = testCompletion;
        testCompletion = undefined;
        testAcknowledged = false;
        completion?.resolve(next.test);
      }
    }
  };
  // Permission may change in System Settings while the app is backgrounded.
  const refreshStatus = () => postMessage({ type: "status" });

  const stops = [
    listen(window, NATIVE_NOTIFICATIONS_STATUS_EVENT, handleStatus),
    listen(window, "focus", refreshStatus),
  ];
  refreshStatus();

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener: (snapshot: NativeNotificationsSnapshot) => void) {
      render = listener;
      return () => {
        render = undefined;
      };
    },
    requestPermission(this: void) {
      postMessage({ type: "request-permission" });
    },
    sendTest(this: void) {
      if (testCompletion) {
        return testCompletion.promise;
      }
      if (snapshot.test?.state === "pending") {
        return undefined;
      }
      testCompletion = Promise.withResolvers();
      // A focus/status reply may still carry the previous test's terminal outcome.
      testAcknowledged = false;
      publish({ ...snapshot, test: { state: "pending" } });
      postMessage({ type: "send-test" });
      return testCompletion.promise;
    },
    backgroundSessionCompleted(this: void, completion: NativeBackgroundSessionCompletion) {
      postMessage({ type: "background-session-completed", ...completion });
    },
    dispose(this: void) {
      stops.forEach((stop) => stop());
      render = undefined;
      testCompletion?.resolve(undefined);
      testCompletion = undefined;
    },
  };
}
