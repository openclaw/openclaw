/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPushNotificationPreferences } from "../../../packages/gateway-protocol/src/schema/push.ts";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { NotificationsSection } from "../pages/config/notifications-section.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../test-helpers/property-descriptor.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { createConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./gateway.ts";
import { autoPromptNotificationsOnSend } from "./notifications-auto-prompt.ts";
import { createWebPushCapability } from "./web-push.ts";

const webProps = { connected: true, presentationRetired: () => new Promise<void>(() => {}) };

const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  "serviceWorker",
);
const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(navigator, "userAgent");
const originalMaxTouchPointsDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "maxTouchPoints",
);
const originalStandaloneDescriptor = Object.getOwnPropertyDescriptor(navigator, "standalone");
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");

function setNavigatorValue(key: string, value: unknown): void {
  Object.defineProperty(navigator, key, { configurable: true, value });
}

function encodedVapidKey(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64url");
}

function existingSubscription(
  vapidBytes: number[],
  endpoint = "https://push.example.test/subscription",
): PushSubscription {
  return {
    endpoint,
    options: {
      applicationServerKey: Uint8Array.from(vapidBytes).buffer,
      userVisibleOnly: true,
    },
    toJSON: () => ({
      endpoint,
      keys: { p256dh: "p256dh", auth: "auth" },
    }),
  } as unknown as PushSubscription;
}

function gatewayHarness() {
  let snapshot = {
    phase: "connecting",
    client: null,
  } as unknown as ApplicationGatewaySnapshot;
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<Parameters<ApplicationGateway["subscribeEvents"]>[0]>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents(listener: Parameters<ApplicationGateway["subscribeEvents"]>[0]) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    connect(
      client: GatewayBrowserClient,
      profileId = "profile-owner",
      scopes = ["operator.admin"],
    ) {
      snapshot = {
        ...snapshot,
        phase: "connected",
        client,
        selfUser: { id: profileId },
        hello: {
          auth: { role: "operator", scopes },
          features: { methods: ["push.web.preferences.get", "push.web.preferences.set"] },
        },
      } as unknown as ApplicationGatewaySnapshot;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    disconnect() {
      snapshot = { ...snapshot, phase: "offline", client: null };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    emit(event: Parameters<Parameters<ApplicationGateway["subscribeEvents"]>[0]>[0]) {
      for (const listener of eventListeners) {
        listener(event);
      }
    },
  };
}

function notificationPreferences(approvalRequested: boolean): WebPushNotificationPreferences {
  return {
    categories: {
      approvalRequested,
      agentFinished: false,
      agentQuestion: false,
      humanMentioned: false,
      scheduledTaskFailed: false,
    },
    detailLevel: "private",
    quietHours: { enabled: false, startMinute: 1_320, endMinute: 420, timeZone: "UTC" },
    agentIds: [],
  };
}

function preferenceResult(user: WebPushNotificationPreferences) {
  return {
    durableIdentity: true,
    user,
    device: { enabled: true, label: "" },
    effective: { ...user, enabled: true, label: "" },
  };
}

/**
 * Settles with the preferences published by the next completed read. The lazy runtime import
 * crosses the Vitest worker's module-fetch boundary, so its latency follows runner load; await
 * the publication instead of polling against a wall-clock budget.
 */
function nextPreferencesPublication(
  capability: ReturnType<typeof createWebPushCapability>,
  signal: AbortSignal,
): Promise<WebPushNotificationPreferences> {
  const published = createDeferred<WebPushNotificationPreferences>();
  const stop = capability.subscribe(() => {
    const read = capability.snapshot.read;
    void read?.then(() => {
      const preferences = capability.snapshot.preferences;
      if (preferences && capability.snapshot.read === read) {
        published.resolve(preferences.user);
      }
    }, published.reject);
  });
  return withinTest(published.promise, signal).finally(stop);
}

function gatewayClient(vapidPublicKey: Promise<string>) {
  const vapidRequested = createDeferred();
  const request = vi.fn(async (method: string) => {
    if (method === "push.web.vapidPublicKey") {
      vapidRequested.resolve();
      return { vapidPublicKey: await vapidPublicKey };
    }
    if (method === "push.web.subscribe") {
      return { subscriptionId: "subscription-1" };
    }
    return { removed: true };
  });
  return { client: { request } as unknown as GatewayBrowserClient, request, vapidRequested };
}

describe("web push Gateway reconciliation", () => {
  beforeEach(() => {
    const subscription = existingSubscription([4, 1, 2, 3]);
    const registration = {
      pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
      },
    });
    vi.stubGlobal("PushManager", vi.fn());
    vi.stubGlobal("Notification", { permission: "granted" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restorePropertyDescriptor(navigator, "userAgent", originalUserAgentDescriptor);
    restorePropertyDescriptor(navigator, "maxTouchPoints", originalMaxTouchPointsDescriptor);
    restorePropertyDescriptor(navigator, "standalone", originalStandaloneDescriptor);
    restorePropertyDescriptor(navigator, "platform", originalPlatformDescriptor);
    restorePropertyDescriptor(navigator, "serviceWorker", originalServiceWorkerDescriptor);
  });

  it("does not offer or prompt for push when the connected guest lacks method access", async () => {
    const request = vi.fn().mockResolvedValue({});
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const harness = gatewayHarness();
    harness.connect({ request } as unknown as GatewayBrowserClient, "guest", [
      "operator.sessions.read",
      "operator.sessions.write",
    ]);
    const capability = createWebPushCapability(harness.gateway);
    try {
      autoPromptNotificationsOnSend({ nativeNotifications: null, webPush: capability });
      expect(requestPermission).not.toHaveBeenCalled();
      await expect(capability.run({ kind: "enable" })).rejects.toThrow("Gateway access");
      expect(requestPermission).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      const { container } = mountSolid(() => (
        <NotificationsSection {...webProps} webPush={capability.snapshot} />
      ));
      expect(container.textContent).toContain("Unavailable");
      expect(container.textContent).toContain("Not requested");
      expect(container.textContent).not.toContain("Enable notifications");
      expect(container.textContent).not.toContain("Send test");
    } finally {
      capability.dispose();
    }
  });

  it("keeps read-only preferences and local opt-out without attempting denied writes", async ({
    signal,
  }) => {
    let rejectPreferences = true;
    const request = vi.fn(async (_method: string) => {
      if (rejectPreferences) {
        throw new Error("Subscription is not owned by the current profile.");
      }
      return preferenceResult(notificationPreferences(true));
    });
    const subscription = existingSubscription([4, 1, 2, 3]);
    const unsubscribe = vi.fn().mockResolvedValue(true);
    subscription.unsubscribe = unsubscribe;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: async () => ({
          pushManager: { getSubscription: async () => subscription },
        }),
      },
    });
    const harness = gatewayHarness();
    harness.connect({ request } as unknown as GatewayBrowserClient, "reader", ["operator.read"]);
    const capability = createWebPushCapability(harness.gateway);
    const localReady = createDeferred();
    const settled = createDeferred();
    const stop = capability.subscribe(() => {
      if (capability.snapshot.subscription === "local") {
        localReady.resolve();
      }
      if (capability.snapshot.preferences) {
        settled.resolve();
      }
    });
    try {
      await withinTest(localReady.promise, signal);
      await expect(capability.snapshot.read).rejects.toThrow("not owned");
      expect(capability.snapshot.preferences).toBeNull();
      rejectPreferences = false;
      harness.emit({
        type: "event",
        event: "users.prefs.changed",
        payload: { keys: ["notifications.web.v1"] },
      });
      await withinTest(settled.promise, signal);
      expect(capability.snapshot).toMatchObject({
        canManage: false,
        canReadPreferences: true,
        subscription: "local",
      });
      expect(capability.snapshot.error).toBeNull();
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "push.web.preferences.get",
        "push.web.preferences.get",
      ]);
      const changePreferences = vi.fn();
      const { container } = mountSolid(() => (
        <NotificationsSection
          {...webProps}
          webPush={capability.snapshot}
          onWebPushSetUserPreferences={changePreferences}
          onWebPushSetDevicePreferences={changePreferences}
        />
      ));
      expect(container.textContent).toContain("Browser subscription only");
      await vi.waitFor(() =>
        expect(container.querySelector(".settings-stack")?.hasAttribute("inert")).toBe(false),
      );
      const controls = container.querySelectorAll(".settings-stack input, .settings-stack select");
      expect(controls.length).toBeGreaterThan(0);
      expect([...controls].every((control) => control.matches(":disabled"))).toBe(true);
      container.querySelector<HTMLInputElement>(".settings-stack input")?.click();
      expect(changePreferences).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Send test");
      await capability.run({ kind: "disable" });
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(capability.snapshot.subscription).toBe("missing");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      capability.dispose();
    }
  });

  it("retires access and cached preferences on the same client and on disconnect", async ({
    signal,
  }) => {
    const request = vi.fn(async (method: string) =>
      method === "push.web.vapidPublicKey"
        ? { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) }
        : preferenceResult(notificationPreferences(true)),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = gatewayHarness();
    harness.connect(client);
    const capability = createWebPushCapability(harness.gateway);
    const settled = createDeferred();
    const stop = capability.subscribe(() => {
      if (capability.snapshot.preferences) {
        settled.resolve();
      }
    });
    try {
      await withinTest(settled.promise, signal);
      request.mockClear();
      harness.connect(client, "guest", ["operator.sessions.write"]);
      expect(capability.snapshot).toMatchObject({
        canManage: false,
        canReadPreferences: false,
        preferences: null,
      });
      await expect(
        capability.run({
          kind: "set",
          scope: "device",
          preferences: { enabled: false, label: "" },
        }),
      ).rejects.toThrow("Gateway access");
      await expect(capability.run({ kind: "test" })).rejects.toThrow("Gateway access");
      expect(request).not.toHaveBeenCalled();
      harness.disconnect();
      expect(capability.snapshot).toMatchObject({
        canManage: false,
        canReadPreferences: false,
        subscription: "unknown",
        preferences: null,
      });
    } finally {
      stop();
      capability.dispose();
    }
  });

  it("rechecks access after a pending browser permission decision before registering", async ({
    signal,
  }) => {
    const permission = createDeferred<NotificationPermission>();
    const requestPermission = vi.fn(() => permission.promise);
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: async () => undefined,
        ready: Promise.resolve({
          pushManager: { getSubscription: async () => null, subscribe: vi.fn() },
        }),
      },
    });
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = gatewayHarness();
    harness.connect(client);
    const capability = createWebPushCapability(harness.gateway);
    const prompted = createDeferred();
    requestPermission.mockImplementation(() => {
      prompted.resolve();
      return permission.promise;
    });
    try {
      const enable = capability.run({ kind: "enable" });
      await withinTest(prompted.promise, signal);
      harness.connect(client, "guest", ["operator.sessions.write"]);
      permission.resolve("granted");
      await enable;
      expect(request).not.toHaveBeenCalled();
      expect(capability.snapshot.command).toBeUndefined();
    } finally {
      permission.resolve("granted");
      capability.dispose();
    }
  });

  it("reconciles changed access while initial registration is queued", async ({ signal }) => {
    const { createWebPushCapabilityRuntime } = await import("./web-push.runtime.ts");
    const coordinator = createConnectionBootstrapCoordinator();
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = gatewayHarness();
    harness.connect(client);
    const settled = createDeferred();
    const stop = createWebPushCapabilityRuntime({
      gateway: harness.gateway,
      connectionBootstrap: coordinator,
      publish: (patch) => {
        if (patch.subscription === "local") {
          settled.resolve();
        }
      },
    });
    try {
      harness.connect(client, "guest", ["operator.sessions.write"]);
      await withinTest(settled.promise, signal);
      expect(request).not.toHaveBeenCalled();
    } finally {
      stop.dispose();
      coordinator.reset();
    }
  });

  it("publishes ordinary browser support synchronously for the first-send prompt", () => {
    const capability = createWebPushCapability(gatewayHarness().gateway);

    expect(capability.snapshot).toMatchObject({ supported: true, permission: "granted" });
    capability.dispose();
  });

  it("makes actions unavailable when the lazy runtime fails to load", async () => {
    // mock-isolation: Reject the lazy import before any real Web Push runtime can execute.
    vi.doMock("./web-push.runtime.ts", () => {
      throw new Error("Web Push runtime unavailable");
    });

    const capability = createWebPushCapability(gatewayHarness().gateway);
    try {
      await vi.waitFor(() =>
        expect(capability.snapshot).toMatchObject({
          supported: false,
          permission: "unsupported",
          subscription: "unknown",
        }),
      );
      await expect(capability.snapshot.read).rejects.toMatchObject({
        cause: { message: "Web Push runtime unavailable" },
      });
      await capability.run({ kind: "enable" });

      expect(capability.snapshot.loading).toBe(false);
    } finally {
      capability.dispose();
      vi.doUnmock("./web-push.runtime.ts");
    }
  });

  it("preserves initial reconciliation failures through the connection bootstrap coordinator", async ({
    signal,
  }) => {
    const coordinator = createConnectionBootstrapCoordinator();
    const run = vi.spyOn(coordinator, "run");
    const harness = gatewayHarness();
    const vapidPublicKey = encodedVapidKey([4, 1, 2, 3]);
    const connection = gatewayClient(Promise.resolve(vapidPublicKey));
    connection.request.mockImplementation(async (method) => {
      if (method === "push.web.preferences.get") {
        throw new Error("Notification preferences are unavailable.");
      }
      return method === "push.web.vapidPublicKey"
        ? { vapidPublicKey }
        : { subscriptionId: "subscription-1" };
    });
    const capability = createWebPushCapability(harness.gateway, {
      connectionBootstrap: coordinator,
    });

    // The read receipt publishes synchronously before the coordinator admits the task.
    const scheduled = createDeferred();
    capability.subscribe(() => {
      if (capability.snapshot.read) {
        scheduled.resolve();
      }
    });
    harness.connect(connection.client);
    await withinTest(scheduled.promise, signal);
    expect(run).toHaveBeenCalledExactlyOnceWith("web-push-reconcile", expect.any(Function));
    expect(connection.request).not.toHaveBeenCalled();
    const read = capability.snapshot.read;
    coordinator.synchronize({ client: connection.client, connected: true });
    try {
      await expect(read).rejects.toThrow("Notification preferences are unavailable.");
      expect(connection.request).toHaveBeenCalledWith(
        "push.web.subscribe",
        expect.objectContaining({ endpoint: "https://push.example.test/subscription" }),
      );
    } finally {
      capability.dispose();
      coordinator.reset();
    }
  });

  it("serializes rapid preference edits without dropping the latest full object", async ({
    signal,
  }) => {
    const initialSubscription = existingSubscription([4, 1, 2, 3]);
    const replacementSubscription = existingSubscription(
      [4, 1, 2, 3],
      "https://push.example.test/replacement",
    );
    let subscription = initialSubscription;
    const registration = {
      pushManager: { getSubscription: async () => subscription },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
      },
    });
    const firstSave = createDeferred();
    const firstSaveStarted = createDeferred();
    const first = notificationPreferences(true);
    const second = notificationPreferences(false);
    let stored = first;
    let saveCount = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.get") {
        return preferenceResult(stored);
      }
      if (method === "push.web.preferences.set") {
        saveCount += 1;
        if (saveCount === 1) {
          firstSaveStarted.resolve();
          await firstSave.promise;
        }
        stored = (params as { preferences: WebPushNotificationPreferences }).preferences;
        return { scope: "user", preferences: stored };
      }
      return {};
    });
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    const initialPublication = nextPreferencesPublication(capability, signal);
    harness.connect({ request } as unknown as GatewayBrowserClient);
    expect(await initialPublication).toEqual(first);
    request.mockClear();

    const firstOperation = capability.run({ kind: "set", scope: "user", preferences: first });
    await withinTest(firstSaveStarted.promise, signal);
    subscription = replacementSubscription;
    const secondOperation = capability.run({ kind: "set", scope: "user", preferences: second });
    firstSave.resolve();

    await Promise.all([firstOperation, secondOperation]);
    expect(request.mock.calls.filter(([method]) => method === "push.web.preferences.set")).toEqual([
      ["push.web.preferences.set", expect.objectContaining({ preferences: first })],
      ["push.web.preferences.set", expect.objectContaining({ preferences: second })],
    ]);
    expect(
      request.mock.calls
        .filter(([method]) => method.startsWith("push.web.preferences."))
        .map(([method, params]) => [method, (params as { endpoint: string }).endpoint]),
    ).toEqual([
      ["push.web.preferences.set", initialSubscription.endpoint],
      ["push.web.preferences.get", initialSubscription.endpoint],
      ["push.web.preferences.set", replacementSubscription.endpoint],
      ["push.web.preferences.get", replacementSubscription.endpoint],
    ]);
    expect(capability.snapshot.preferences?.user).toEqual(second);
    capability.dispose();
  });

  it("refreshes routed canonical profile defaults without publishing a stale invalidation", async ({
    signal,
  }) => {
    const initial = notificationPreferences(true);
    const stale = { ...notificationPreferences(true), detailLevel: "detailed" as const };
    const latest = notificationPreferences(false);
    const firstRefresh = createDeferred<ReturnType<typeof preferenceResult>>();
    const firstRefreshStarted = createDeferred();
    let preferenceRead = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.get") {
        preferenceRead += 1;
        if (preferenceRead === 1) {
          return preferenceResult(initial);
        }
        if (preferenceRead === 2) {
          firstRefreshStarted.resolve();
          return await firstRefresh.promise;
        }
        return preferenceResult(latest);
      }
      return {};
    });
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    try {
      const initialPublication = nextPreferencesPublication(capability, signal);
      harness.connect({ request } as unknown as GatewayBrowserClient, "profile-owner");
      expect(await initialPublication).toEqual(initial);

      harness.emit({
        type: "event",
        event: "users.prefs.changed",
        payload: { profileId: "canonical-profile", keys: ["ui.theme"] },
      });
      expect(preferenceRead).toBe(1);

      const invalidation = {
        type: "event" as const,
        event: "users.prefs.changed",
        payload: { profileId: "canonical-profile", keys: ["notifications.web.v1"] },
      };
      const latestPublication = nextPreferencesPublication(capability, signal);
      harness.emit(invalidation);
      await withinTest(
        awaitGateBeforeSettlement(
          firstRefreshStarted.promise,
          latestPublication,
          "Preference refresh settled before requesting current preferences.",
        ),
        signal,
      );
      expect(preferenceRead).toBe(2);
      harness.emit(invalidation);
      expect(await latestPublication).toEqual(latest);
      firstRefresh.resolve(preferenceResult(stale));
      await Promise.resolve();

      expect(capability.snapshot.preferences?.user).toEqual(latest);
    } finally {
      firstRefresh.resolve(preferenceResult(stale));
      capability.dispose();
    }
  });

  it("retires pending reconciliation when the profile changes on the same client", async ({
    signal,
  }) => {
    const firstKey = createDeferred<string>();
    const firstKeyRequested = createDeferred();
    let keyReads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "push.web.vapidPublicKey") {
        keyReads += 1;
        firstKeyRequested.resolve();
        return {
          vapidPublicKey: keyReads === 1 ? await firstKey.promise : encodedVapidKey([4, 1, 2, 3]),
        };
      }
      return preferenceResult(notificationPreferences(false));
    });
    const harness = gatewayHarness();
    const client = { request } as unknown as GatewayBrowserClient;
    const capability = createWebPushCapability(harness.gateway);
    try {
      harness.connect(client, "first-profile");
      await withinTest(firstKeyRequested.promise, signal);
      expect(keyReads).toBe(1);
      const secondProfilePublication = nextPreferencesPublication(capability, signal);
      harness.connect(client, "second-profile");
      expect(await secondProfilePublication).toEqual(notificationPreferences(false));
      firstKey.resolve(encodedVapidKey([4, 9, 8, 7]));
      await Promise.resolve();
      expect(capability.snapshot.subscription).toBe("registered");
    } finally {
      firstKey.resolve(encodedVapidKey([4, 1, 2, 3]));
      capability.dispose();
    }
  });

  it("reruns full reconciliation when preferences change during initial connection", async ({
    signal,
  }) => {
    const firstKey = createDeferred<string>();
    const firstKeyRequested = createDeferred();
    let vapidRead = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "push.web.vapidPublicKey") {
        vapidRead += 1;
        firstKeyRequested.resolve();
        return {
          vapidPublicKey: vapidRead === 1 ? await firstKey.promise : encodedVapidKey([4, 1, 2, 3]),
        };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.get") {
        return preferenceResult(notificationPreferences(false));
      }
      return {};
    });
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    harness.connect({ request } as unknown as GatewayBrowserClient, "profile-owner");
    await withinTest(firstKeyRequested.promise, signal);
    expect(vapidRead).toBe(1);

    const rerunPublication = nextPreferencesPublication(capability, signal);
    harness.emit({
      type: "event",
      event: "users.prefs.changed",
      payload: { profileId: "profile-owner", keys: ["notifications.web.v1"] },
    });

    expect(await rerunPublication).toEqual(notificationPreferences(false));
    expect(vapidRead).toBe(2);
    firstKey.resolve(encodedVapidKey([4, 9, 8, 7]));
    await Promise.resolve();
    expect(capability.snapshot.error).toBeNull();
    capability.dispose();
  });

  it.each([
    ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 1, ""],
    ["iPad", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", 5, ""],
    [
      "desktop-mode iPad",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15",
      5,
      "MacIntel",
    ],
  ])(
    "requires Home Screen installation on %s Safari",
    async (_label, userAgent, maxTouchPoints, platform) => {
      setNavigatorValue("userAgent", userAgent);
      setNavigatorValue("maxTouchPoints", maxTouchPoints);
      setNavigatorValue("standalone", false);
      setNavigatorValue("platform", platform);

      const capability = createWebPushCapability(gatewayHarness().gateway);

      await vi.waitFor(() =>
        expect(capability.snapshot).toMatchObject({
          supported: false,
          permission: "install-required",
        }),
      );
      capability.dispose();
    },
  );

  it("requires Home Screen installation in an iPhone browser shell without standalone", () => {
    setNavigatorValue("userAgent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    Reflect.deleteProperty(navigator, "standalone");

    const capability = createWebPushCapability(gatewayHarness().gateway);

    expect(capability.snapshot).toMatchObject({
      supported: false,
      permission: "install-required",
    });
    capability.dispose();
  });

  it("requires Home Screen installation before Web Push APIs are exposed", async () => {
    setNavigatorValue("userAgent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    setNavigatorValue("standalone", false);
    Reflect.deleteProperty(navigator, "serviceWorker");
    Reflect.deleteProperty(globalThis, "PushManager");
    Reflect.deleteProperty(globalThis, "Notification");

    const capability = createWebPushCapability(gatewayHarness().gateway);

    await vi.waitFor(() =>
      expect(capability.snapshot).toMatchObject({
        supported: false,
        permission: "install-required",
      }),
    );
    capability.dispose();
  });

  it("enables Web Push for an installed iOS PWA", async () => {
    setNavigatorValue("userAgent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)");
    setNavigatorValue("maxTouchPoints", 5);
    setNavigatorValue("standalone", true);
    setNavigatorValue("platform", "MacIntel");

    const capability = createWebPushCapability(gatewayHarness().gateway);

    await vi.waitFor(() =>
      expect(capability.snapshot).toMatchObject({
        supported: true,
        permission: "granted",
      }),
    );
    capability.dispose();
  });

  it("ignores stale reconciliation after switching Gateways", async ({ signal }) => {
    const firstKey = createDeferred<string>();
    const secondKey = createDeferred<string>();
    const first = gatewayClient(firstKey.promise);
    const second = gatewayClient(secondKey.promise);
    const harness = gatewayHarness();
    const coordinator = createConnectionBootstrapCoordinator();
    const capability = createWebPushCapability(harness.gateway, {
      connectionBootstrap: coordinator,
    });

    coordinator.synchronize({ client: first.client, connected: true });
    harness.connect(first.client);
    await withinTest(first.vapidRequested.promise, signal);
    const firstReconciliation = coordinator.run("web-push-reconcile", async () => {});
    coordinator.synchronize({ client: second.client, connected: true });
    harness.connect(second.client);
    expect(capability.snapshot).toMatchObject({ subscription: "unknown", preferences: null });
    const secondRead = capability.snapshot.read;
    await withinTest(second.vapidRequested.promise, signal);

    secondKey.resolve(encodedVapidKey([4, 9, 8, 7]));
    await withinTest(Promise.resolve(secondRead), signal);
    expect(capability.snapshot.error).toContain("another Gateway");
    expect(capability.snapshot.subscription).toBe("vapid-mismatch");

    firstKey.resolve(encodedVapidKey([4, 1, 2, 3]));
    await firstReconciliation;
    expect(first.request).not.toHaveBeenCalledWith("push.web.subscribe", expect.anything());
    expect(capability.snapshot.error).toContain("another Gateway");
    expect(capability.snapshot.subscription).toBe("vapid-mismatch");
    capability.dispose();
    coordinator.reset();
  });

  it("ignores a stale preference action after switching Gateways", async ({ signal }) => {
    const firstSave = createDeferred();
    const firstSaveStarted = createDeferred();
    const stalePreferences = notificationPreferences(true);
    const currentPreferences = notificationPreferences(false);
    const firstRequest = vi.fn(async (method: string) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.set") {
        firstSaveStarted.resolve();
        await firstSave.promise;
        return { scope: "user", preferences: stalePreferences };
      }
      if (method === "push.web.preferences.get") {
        return preferenceResult(stalePreferences);
      }
      return {};
    });
    const secondRequest = vi.fn(async (method: string) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.get") {
        return preferenceResult(currentPreferences);
      }
      return {};
    });
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    const initialPublication = nextPreferencesPublication(capability, signal);
    harness.connect({ request: firstRequest } as unknown as GatewayBrowserClient);
    expect(await initialPublication).toEqual(stalePreferences);

    const action = capability.run({
      kind: "set",
      scope: "user",
      preferences: stalePreferences,
    });
    await withinTest(firstSaveStarted.promise, signal);
    const currentPublication = nextPreferencesPublication(capability, signal);
    harness.connect({ request: secondRequest } as unknown as GatewayBrowserClient);
    expect(await currentPublication).toEqual(currentPreferences);

    await action;
    firstSave.resolve();

    expect(capability.snapshot.preferences?.user).toEqual(currentPreferences);
    expect(capability.snapshot.error).toBeNull();
    capability.dispose();
  });

  it("keeps the current Gateway error when a queued stale action begins", async ({ signal }) => {
    const firstSave = createDeferred();
    const firstSaveStarted = createDeferred();
    const preferences = notificationPreferences(true);
    let saveCount = 0;
    const firstRequest = vi.fn(async (method: string) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.set") {
        saveCount += 1;
        if (saveCount === 1) {
          firstSaveStarted.resolve();
          await firstSave.promise;
        }
        return { scope: "user", preferences };
      }
      if (method === "push.web.preferences.get") {
        return preferenceResult(preferences);
      }
      return {};
    });
    const second = gatewayClient(Promise.resolve(encodedVapidKey([4, 9, 8, 7])));
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    const initialPublication = nextPreferencesPublication(capability, signal);
    harness.connect({ request: firstRequest } as unknown as GatewayBrowserClient);
    expect(await initialPublication).toEqual(preferences);

    const firstAction = capability.run({ kind: "set", scope: "user", preferences });
    await withinTest(firstSaveStarted.promise, signal);
    expect(saveCount).toBe(1);
    const queuedAction = capability.run({ kind: "set", scope: "user", preferences });
    await Promise.resolve();
    harness.connect(second.client);
    await vi.waitFor(() => expect(capability.snapshot.error).toContain("another Gateway"));

    firstSave.resolve();
    await Promise.all([firstAction, queuedAction]);

    expect(capability.snapshot.error).toContain("another Gateway");
    expect(capability.snapshot.subscription).toBe("vapid-mismatch");
    capability.dispose();
  });

  it.for(["reconnect", "enable"] as const)(
    "resets a mismatched browser subscription detected during %s from Settings before enabling the new Gateway",
    async (source, { signal }) => {
      const unsubscribe = vi.fn(async () => {
        currentSubscription = null;
        return true;
      });
      const mismatchedSubscription = existingSubscription([4, 1, 2, 3]);
      mismatchedSubscription.unsubscribe = unsubscribe;
      let currentSubscription: PushSubscription | null =
        source === "reconnect" ? mismatchedSubscription : null;
      const subscribe = vi.fn(async () => {
        currentSubscription = existingSubscription([4, 9, 8, 7]);
        return currentSubscription;
      });
      const registration = {
        pushManager: {
          getSubscription: async () => currentSubscription,
          subscribe,
        },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
        },
      });
      vi.stubGlobal("Notification", {
        permission: "granted",
        requestPermission: vi.fn().mockResolvedValue("granted"),
      });
      const request = vi.fn(async (method: string) => {
        if (method === "push.web.vapidPublicKey") {
          return { vapidPublicKey: encodedVapidKey([4, 9, 8, 7]) };
        }
        if (method === "push.web.preferences.get") {
          return preferenceResult(notificationPreferences(true));
        }
        return { subscriptionId: "subscription-1", removed: true };
      });
      const harness = gatewayHarness();
      const capability = createWebPushCapability(harness.gateway);
      const container = document.createElement("div");
      const [snapshot, setSnapshot] = createSignal(capability.snapshot);
      const { unmount: dispose } = mountSolid(
        () => (
          <NotificationsSection
            {...webProps}
            webPush={snapshot()}
            onWebPushSubscribe={() => capability.run({ kind: "enable" })}
            onWebPushUnsubscribe={() => capability.run({ kind: "disable" })}
          />
        ),
        { container },
      );
      const initialRead = createDeferred<unknown>();
      const stop = capability.subscribe(() => {
        setSnapshot({ ...capability.snapshot });
        flush();
        void capability.snapshot.read?.then(initialRead.resolve, initialRead.reject);
      });
      const button = (label: string) =>
        Array.from(container.querySelectorAll("button")).find((candidate) =>
          candidate.textContent?.includes(label),
        );

      try {
        harness.connect({ request } as unknown as GatewayBrowserClient);
        await withinTest(initialRead.promise, signal);
        if (source === "enable") {
          expect(capability.snapshot.subscription).toBe("missing");
          currentSubscription = mismatchedSubscription;
          button("Enable notifications")?.click();
        }
        await vi.waitFor(() => expect(container.textContent).toContain("another Gateway"));
        expect(request).toHaveBeenCalledWith("push.web.unsubscribe", {
          endpoint: mismatchedSubscription.endpoint,
        });
        expect(request).not.toHaveBeenCalledWith("push.web.subscribe", expect.anything());
        expect(subscribe).not.toHaveBeenCalled();
        expect(unsubscribe).not.toHaveBeenCalled();
        expect(container.textContent).toContain("Not subscribed");
        expect(button("Send test")).toBeUndefined();
        const resetButton = button("Unsubscribe");
        expect(resetButton).toBeDefined();
        await vi.waitFor(() => expect(resetButton?.disabled).toBe(false));
        resetButton?.click();
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(button("Enable notifications")?.disabled).toBe(false));
        button("Enable notifications")?.click();

        await vi.waitFor(() => expect(button("Send test")?.disabled).toBe(false));
        expect(subscribe).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith("push.web.subscribe", {
          endpoint: "https://push.example.test/subscription",
          keys: { p256dh: "p256dh", auth: "auth" },
        });
        expect(container.textContent).not.toContain("another Gateway");
      } finally {
        stop();
        capability.dispose();
        dispose();
      }
    },
  );
});
