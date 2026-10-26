/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createWebPushCapability } from "../../app/web-push.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { completeConfigContext } from "./config-page.test-support.ts";
import { mountConfigCommandRoutes } from "./updates.test-support.ts";

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

afterEach(() => {
  vi.unstubAllGlobals();
  restorePropertyDescriptor(navigator, "serviceWorker", originalServiceWorker);
});

it("leaves the notifications route before an admitted Web Push command settles", async () => {
  const pending = createDeferred();
  const vapidKey = Uint8Array.from([4, 1, 2, 3]);
  const serializedSubscription = {
    endpoint: "https://push.example.test/subscription",
    keys: { p256dh: "p256dh", auth: "auth" },
  };
  const subscription = {
    endpoint: serializedSubscription.endpoint,
    options: { applicationServerKey: vapidKey.buffer, userVisibleOnly: true },
    toJSON: () => serializedSubscription,
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => ({
        pushManager: { getSubscription: async () => subscription },
      }),
    },
  });
  vi.stubGlobal("PushManager", vi.fn());
  vi.stubGlobal("Notification", { permission: "granted" });
  const user = {
    categories: {
      approvalRequested: true,
      agentFinished: false,
      agentQuestion: false,
      humanMentioned: false,
      scheduledTaskFailed: false,
    },
    detailLevel: "private",
    quietHours: { enabled: false, startMinute: 1320, endMinute: 420, timeZone: "UTC" },
    agentIds: [],
  };
  const device = { enabled: true, label: "Synthetic browser" };
  const request = vi.fn(async (method: string) => {
    if (method === "push.web.vapidPublicKey") {
      return { vapidPublicKey: Buffer.from(vapidKey).toString("base64url") };
    }
    if (method === "push.web.preferences.get") {
      return { durableIdentity: true, user, device, effective: { ...user, ...device } };
    }
    if (method === "push.web.test") {
      await pending.promise;
    }
    return { subscriptionId: "subscription-1" };
  });
  const { gateway } = createApplicationGateway();
  Object.assign(gateway.snapshot, {
    phase: "connected",
    client: createTestGatewayClient(request),
    selfUser: { id: "profile-owner" },
    hello: { auth: { role: "operator", scopes: ["operator.admin"] } },
  });
  const capability = createWebPushCapability(gateway);
  const context = completeConfigContext({
    gateway,
    webPush: capability,
  } as unknown as ApplicationContext);
  const { router, view: outlet } = await mountConfigCommandRoutes(
    context,
    "notifications",
    "usage",
  );
  const send = () =>
    Array.from(outlet.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Send test"),
    );
  try {
    await router.navigate("notifications", context);
    await waitForSolid(() => expect(send()?.disabled).toBe(false));
    send()!.click();
    await waitForSolid(() => expect(capability.snapshot.loading).toBe(true));

    await router.navigate("usage", context);
    await waitForSolid(() => {
      expect(outlet.textContent).toContain("Usage destination");
      expect(outlet.querySelector("openclaw-config-page")).toBeNull();
    });
    expect(capability.snapshot.loading).toBe(true);

    pending.resolve();
    await waitForSolid(() => expect(capability.snapshot.loading).toBe(false));
    expect(outlet.textContent).toContain("Usage destination");
    expect(outlet.querySelector("openclaw-config-page")).toBeNull();
  } finally {
    pending.resolve();
    outlet.dispose();
    router.stop();
    capability.dispose();
  }
});
