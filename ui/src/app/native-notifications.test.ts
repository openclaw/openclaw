/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createNativeNotificationsCapability,
  type NativeNotificationsCapability,
} from "./native-notifications.ts";

type NativeNotificationsMessage = {
  type: "status" | "request-permission" | "send-test";
};

let capability: NativeNotificationsCapability | null = null;
let postMessage: ReturnType<typeof vi.fn<(message: NativeNotificationsMessage) => void>>;
type NotificationListener = Parameters<NativeNotificationsCapability["subscribe"]>[0];
let listener: ReturnType<typeof vi.fn<NotificationListener>>;

beforeEach(() => {
  postMessage = vi.fn<(message: NativeNotificationsMessage) => void>();
  vi.stubGlobal("webkit", { messageHandlers: { openclawNotifications: { postMessage } } });
  capability = createNativeNotificationsCapability();
  listener = vi.fn<NotificationListener>();
  capability?.subscribe(listener);
  postMessage.mockClear();
});

afterEach(() => {
  capability?.dispose();
  capability = null;
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_NOTIFICATIONS__");
  vi.unstubAllGlobals();
});

function publish(detail: unknown) {
  // Literal wire contract shared with the Mac app bridge.
  window.dispatchEvent(new CustomEvent("openclaw:native-notifications-status", { detail }));
}

it("returns null without the WebKit bridge", () => {
  vi.unstubAllGlobals();
  expect(createNativeNotificationsCapability()).toBeNull();
});

it.each([
  ["denied", { permission: "denied", test: null }, [{ permission: "denied", test: null }]],
  ["authorized", { permission: "unknown", test: null }, []],
] as const)("validates the %s permission event", (permission, expected, deliveries) => {
  publish(permission === "denied" ? { permission, test: null } : { permission });
  expect(capability?.snapshot).toEqual(expected);
  expect(listener.mock.calls).toEqual(deliveries.map((snapshot) => [snapshot]));
});

it("shares a test receipt and settles only after the native pending acknowledgement", async () => {
  const completion = capability?.sendTest();
  expect(capability?.sendTest()).toBe(completion);
  expect(capability?.snapshot).toEqual({ permission: "unknown", test: { state: "pending" } });
  expect(postMessage.mock.calls).toEqual([[{ type: "send-test" }]]);
  const settled = vi.fn();
  void completion?.then(settled);
  publish({ permission: "granted", test: { state: "sent" } });
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  publish({ permission: "granted", test: { state: "pending" } });
  publish({ permission: "granted", test: { state: "error", message: "Try again." } });
  await expect(completion).resolves.toEqual({ state: "error", message: "Try again." });
  expect(capability?.snapshot.test).toEqual({ state: "error", message: "Try again." });
});

it("forwards completion to the native permission owner without prompting", () => {
  publish({ permission: "notDetermined", test: null });
  capability?.backgroundSessionCompleted({ runId: "run-1", path: "/chat/research" });
  expect(postMessage.mock.calls).toEqual([
    [{ type: "background-session-completed", runId: "run-1", path: "/chat/research" }],
  ]);
});

it("keeps permission and failed send as independent facts across focus refresh", () => {
  const failed = {
    permission: "granted",
    test: { state: "error", message: "Open System Settings and try again." },
  };
  publish(failed);
  window.dispatchEvent(new Event("focus"));
  expect(capability?.snapshot).toEqual(failed);
  expect(postMessage).toHaveBeenCalledWith({ type: "status" });
});

it("retires a pending receipt and removes listeners on dispose", async () => {
  const completion = capability?.sendTest();
  listener.mockClear();
  capability?.dispose();
  capability = null;
  postMessage.mockClear();
  window.dispatchEvent(new Event("focus"));
  publish({ permission: "granted", test: null });
  expect(postMessage).not.toHaveBeenCalled();
  expect(listener).not.toHaveBeenCalled();
  await expect(completion).resolves.toBeUndefined();
});
