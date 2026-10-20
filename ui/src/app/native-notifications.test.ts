/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeNotificationsCapability,
  type NativeNotificationsCapability,
} from "./native-notifications.ts";

// Wire contract shared with the Mac app bridge; asserted literally on purpose.
const NATIVE_NOTIFICATIONS_STATUS_EVENT = "openclaw:native-notifications-status";

type NativeNotificationsMessage = {
  type: "status" | "request-permission" | "send-test";
};

let capability: NativeNotificationsCapability | null = null;

afterEach(() => {
  capability?.dispose();
  capability = null;
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_NOTIFICATIONS__");
  vi.unstubAllGlobals();
});

function installBridge() {
  const postMessage = vi.fn<(message: NativeNotificationsMessage) => void>();
  vi.stubGlobal("webkit", {
    messageHandlers: { openclawNotifications: { postMessage } },
  });
  capability = createNativeNotificationsCapability();
  return postMessage;
}

function publish(detail: unknown) {
  window.dispatchEvent(new CustomEvent(NATIVE_NOTIFICATIONS_STATUS_EVENT, { detail }));
}

function subscribe() {
  installBridge();
  const listener = vi.fn();
  capability?.subscribe(listener);
  return listener;
}

describe("native notifications", () => {
  it("returns null without the WebKit bridge", () => {
    expect(createNativeNotificationsCapability()).toBeNull();
  });

  it("publishes valid status events", () => {
    const listener = subscribe();
    publish({ permission: "denied", test: null });
    expect(capability?.snapshot).toEqual({ permission: "denied", test: null });
    expect(listener).toHaveBeenCalledWith({ permission: "denied", test: null });
  });

  it("ignores invalid status event details", () => {
    const listener = subscribe();
    publish({ permission: "authorized" });
    expect(capability?.snapshot).toEqual({ permission: "unknown", test: null });
    expect(listener).not.toHaveBeenCalled();
  });

  it("posts permission requests", () => {
    const postMessage = installBridge();
    postMessage.mockClear();
    capability?.requestPermission();
    expect(postMessage).toHaveBeenCalledWith({ type: "request-permission" });
  });

  it("publishes pending immediately and suppresses duplicate test sends", () => {
    const postMessage = installBridge();
    postMessage.mockClear();
    capability?.sendTest();
    capability?.sendTest();
    expect(capability?.snapshot).toEqual({ permission: "unknown", test: { state: "pending" } });
    expect(postMessage.mock.calls).toEqual([[{ type: "send-test" }]]);
  });

  it("forwards completion to the native permission owner without prompting", () => {
    const postMessage = installBridge();
    publish({ permission: "notDetermined", test: null });
    postMessage.mockClear();
    capability?.backgroundSessionCompleted({ runId: "run-1", path: "/chat/research" });
    expect(postMessage.mock.calls).toEqual([
      [{ type: "background-session-completed", runId: "run-1", path: "/chat/research" }],
    ]);
  });

  it("keeps permission and failed send as independent facts across focus refresh", () => {
    const postMessage = installBridge();
    const failed = {
      permission: "granted",
      test: { state: "error", message: "Open System Settings and try again." },
    };
    publish({ ...failed, test: { ...failed.test } });
    postMessage.mockClear();
    window.dispatchEvent(new Event("focus"));
    expect(capability?.snapshot).toEqual(failed);
    expect(postMessage).toHaveBeenCalledWith({ type: "status" });
  });

  it("removes listeners on dispose", () => {
    const postMessage = installBridge();
    const listener = vi.fn();
    capability?.subscribe(listener);
    capability?.dispose();
    capability = null;
    postMessage.mockClear();
    window.dispatchEvent(new Event("focus"));
    publish({ permission: "granted", test: null });
    expect(postMessage).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
