/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { restorePropertyDescriptor } from "../test-helpers/property-descriptor.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { autoPromptNotificationsOnSend } from "./notifications-auto-prompt.ts";
import {
  getExistingSubscription,
  subscribeToWebPush,
  unsubscribeFromWebPush,
} from "./web-push.runtime.ts";

const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  "serviceWorker",
);

function installServiceWorker(
  ready: Promise<ServiceWorkerRegistration>,
  getRegistration: () => Promise<ServiceWorkerRegistration | undefined> = () => ready,
): void {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready, getRegistration },
  });
}

const vapidBytes = [4, 1, 2, 3];
function existingSubscription(): PushSubscription {
  return {
    endpoint: "https://push.example.test/subscription",
    options: {
      applicationServerKey: Uint8Array.from(vapidBytes).buffer,
      userVisibleOnly: true,
    },
    toJSON: () => ({
      endpoint: "https://push.example.test/subscription",
      keys: { p256dh: "p256dh", auth: "auth" },
    }),
  } as unknown as PushSubscription;
}

function gatewayClient() {
  const request = vi.fn(async (method: string) =>
    method === "push.web.vapidPublicKey"
      ? { vapidPublicKey: Buffer.from(vapidBytes).toString("base64url") }
      : {},
  );
  return { client: { request } as unknown as GatewayBrowserClient, request };
}

function grantPermission() {
  vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("granted") });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restorePropertyDescriptor(navigator, "serviceWorker", originalServiceWorkerDescriptor);
});

it("returns no subscription without waiting for an unregistered service worker", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  installServiceWorker(new Promise<ServiceWorkerRegistration>(() => {}), async () => undefined);

  const result = expect(getExistingSubscription()).resolves.toBeNull();
  await Promise.all([result, vi.advanceTimersByTimeAsync(10_000)]);
});

it("treats a registration without PushManager as unsupported instead of throwing", async () => {
  installServiceWorker(Promise.resolve({} as ServiceWorkerRegistration));
  await expect(getExistingSubscription()).resolves.toBeNull();
});

it("still rejects when service worker readiness times out", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  installServiceWorker(new Promise<ServiceWorkerRegistration>(() => {}));
  grantPermission();

  const subscription = subscribeToWebPush(gatewayClient().client, () => {});
  const rejection = expect(subscription).rejects.toThrow("Service worker not ready (timed out)");
  await vi.advanceTimersByTimeAsync(10_000);

  await rejection;
  expect(vi.getTimerCount()).toBe(0);
});

it("unsubscribes locally without waiting for activation when the Gateway no longer owns the subscription row", async () => {
  const subscription = existingSubscription();
  const unsubscribe = vi.fn().mockResolvedValue(true);
  subscription.unsubscribe = unsubscribe;
  installServiceWorker(new Promise<ServiceWorkerRegistration>(() => {}), async () =>
    registration(subscription),
  );
  const request = vi.fn().mockRejectedValue(new Error("FORBIDDEN"));

  await expect(
    unsubscribeFromWebPush({ request } as unknown as GatewayBrowserClient),
  ).resolves.toBeUndefined();

  expect(request).toHaveBeenCalledWith("push.web.unsubscribe", {
    endpoint: subscription.endpoint,
  });
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it("reuses a matching VAPID subscription and clears each readiness timeout", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const subscription = existingSubscription();
  const subscribe = vi
    .fn()
    .mockRejectedValue(new DOMException("Options differ", "InvalidStateError"));
  installServiceWorker(Promise.resolve(registration(subscription, subscribe)));
  grantPermission();
  const { client, request } = gatewayClient();

  await expect(subscribeToWebPush(client, () => {})).resolves.toEqual({
    state: "registered",
    subscription,
  });
  expect(vi.getTimerCount()).toBe(0);
  expect(request).toHaveBeenNthCalledWith(1, "push.web.vapidPublicKey", {});
  expect(request).toHaveBeenNthCalledWith(2, "push.web.subscribe", {
    endpoint: subscription.endpoint,
    keys: { p256dh: "p256dh", auth: "auth" },
  });
  expect(subscribe).not.toHaveBeenCalled();
});

function registration(subscription: PushSubscription, subscribe = vi.fn()) {
  return {
    pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription), subscribe },
  } as unknown as ServiceWorkerRegistration;
}

it.each(["loading", "native denied", "storage unavailable"])(
  "does not prompt or mark onboarding when %s",
  (condition) => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage);
    const browserPermission = vi.fn(async () => "granted");
    const nativePermission = vi.fn();
    const enable = vi.fn(async () => undefined);
    vi.stubGlobal("Notification", { requestPermission: browserPermission });
    if (condition === "storage unavailable") {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          throw new Error("opaque origin");
        },
      });
    }
    const context = {
      nativeNotifications:
        condition === "loading"
          ? null
          : {
              snapshot: { permission: condition === "native denied" ? "denied" : "notDetermined" },
              requestPermission: nativePermission,
            },
      webPush: {
        snapshot: {
          supported: true,
          canManage: true,
          canReadPreferences: true,
          permission: "default",
          subscription: "unknown",
          loading: condition === "loading",
          error: null,
        },
        run: enable,
      },
    } as unknown as Parameters<typeof autoPromptNotificationsOnSend>[0];
    expect(() => autoPromptNotificationsOnSend(context)).not.toThrow();
    expect([browserPermission.mock.calls, nativePermission.mock.calls, enable.mock.calls]).toEqual([
      [],
      [],
      [],
    ]);
    expect(storage.getItem("openclaw.control.notificationsAutoPrompt.v1")).toBeNull();
  },
);
