/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createNativeDeviceSettingsCapability,
  type NativeDeviceSettingsSnapshot,
} from "../../app/native-device-settings.ts";
import { createNativeNotificationsCapability } from "../../app/native-notifications.ts";
import { createApplicationOverlays } from "../../app/overlays.ts";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
import { createWebPushCapability } from "../../app/web-push.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { settleLitElement, settleLitElements } from "../../test-helpers/lit-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ConfigPage } from "./config-page.ts";
import { renderNotificationsSection } from "./notifications-section.ts";
import type { ConfigRouteData } from "./route-data.ts";
import { pages } from "./route.ts";

// Contract fixture only: no iPhone, native permission, live Gateway, or external push service.
const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const restoreProperties: Array<() => void> = [];
const disposables: Array<{ dispose(): void }> = [];
function setProperty(target: object, key: string, value: unknown) {
  const before = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  restoreProperties.push(() => {
    if (before) Object.defineProperty(target, key, before);
    else Reflect.deleteProperty(target, key);
  });
}

function iosSnapshot(
  permission: NativeDeviceSettingsSnapshot["permissions"]["entries"][number]["status"] = "granted",
  enabled = true,
  revision = 1,
): NativeDeviceSettingsSnapshot {
  return {
    contract: 1,
    revision,
    device: {
      platform: "ios",
      formFactor: "phone",
      appVersion: "test",
      appBuild: "1",
      profileName: null,
    },
    app: { notificationsEnabled: enabled },
    permissions: { entries: [{ id: "notifications", status: permission }] },
    voice: { supported: false, wakeEnabled: false },
  };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/settings/notifications");
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  setProperty(navigator, "userAgent", IOS_UA);
  setProperty(navigator, "platform", "iPhone");
  setProperty(navigator, "maxTouchPoints", 5);
  // WKWebView does not advertise Safari's installed-PWA standalone flag.
  setProperty(navigator, "standalone", undefined);
  setProperty(window, "webkit", undefined);
  setProperty(window, "__OPENCLAW_NATIVE_DEVICE_SETTINGS__", undefined);
  setProperty(window, "__OPENCLAW_NATIVE_NOTIFICATIONS__", undefined);
});

afterEach(async () => {
  const mounted = document.querySelectorAll<ConfigPage>("openclaw-config-page");
  document.body.replaceChildren();
  await settleLitElements(mounted);
  for (const disposable of disposables.splice(0)) disposable.dispose();
  // Settle the supported Web Push lazy runtime without starting a Gateway connection.
  await Promise.resolve();
  resetServerUiPrefsSync();
  for (const restore of restoreProperties.splice(0).reverse()) restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountNotifications(basePath = "") {
  const subscribe = () => () => undefined;
  const { gateway } = createApplicationGateway({
    client: null,
    phase: "offline",
    offlineStable: true,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  });
  const webPush = createWebPushCapability(gateway);
  const nativeNotifications = createNativeNotificationsCapability();
  const nativeDeviceSettings = createNativeDeviceSettingsCapability();
  disposables.push(webPush);
  if (nativeNotifications) disposables.push(nativeNotifications);
  if (nativeDeviceSettings) disposables.push(nativeDeviceSettings);
  const config = {};
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  Object.assign(runtimeConfig.state, {
    configSnapshot: { config, runtimeConfig: config, hash: "notifications-test" },
    configSchema: { type: "object", properties: {} },
    configForm: config,
    configFormOriginal: config,
    configRaw: "{}",
    configRawOriginal: "{}",
    configValid: true,
  });
  const settingsAgentSelection = createAgentSelectionCapability(gateway, {
    state: { agentsList: null },
    subscribe,
  });
  const overlays = createApplicationOverlays(gateway);
  const navigate = vi.fn<ApplicationContext["navigate"]>();
  disposables.push(runtimeConfig, settingsAgentSelection, overlays);
  const context = {
    basePath,
    gateway,
    settingsAgentSelection,
    config: createApplicationConfigCapability({ resourceBasePath: basePath }),
    runtimeConfig,
    theme: { serverSelection: null, subscribe },
    overlays,
    navigate,
    nativeDeviceSettings,
    nativeNotifications,
    webPush,
  } satisfies Pick<
    ApplicationContext,
    | "basePath"
    | "gateway"
    | "settingsAgentSelection"
    | "config"
    | "runtimeConfig"
    | "overlays"
    | "navigate"
    | "nativeDeviceSettings"
    | "nativeNotifications"
    | "webPush"
  > & { theme: Pick<ApplicationContext["theme"], "serverSelection" | "subscribe"> };
  // The shared router/context provider accepts the full app; this fixture supplies
  // the typed capabilities consumed by the Notifications route and ConfigPage.
  const application = context as ApplicationContext;
  const route = pages.find((entry) => entry.id === "notifications")!;
  const location = { pathname: "/settings/notifications", search: "", hash: "" };
  const data = await route.loader?.(application, {
    location,
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    deps: route.loaderDeps!(application, location),
    cause: "navigation",
  });
  const module = await route.component();
  const provider = createApplicationContextProvider(application);
  document.body.append(provider);
  render(module.render(data as ConfigRouteData), provider);
  const page = provider.querySelector<ConfigPage>("openclaw-config-page")!;
  await settleLitElement(page);
  expect(page.querySelector("#settings-communications-notifications")).not.toBeNull();
  return { page, webPush, nativeNotifications, nativeDeviceSettings, navigate };
}

function wasNavigationHandled(
  container: HTMLElement,
  link: HTMLAnchorElement,
  init: MouseEventInit = {},
) {
  let handled = false;
  container.addEventListener(
    "click",
    (event) => {
      handled = event.defaultPrevented;
      // Observe production interception before preventing jsdom's document navigation.
      event.preventDefault();
    },
    { once: true },
  );
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  return handled;
}

function installIosBridge(snapshot: unknown) {
  const postMessage = vi.fn(async () => undefined);
  setProperty(window, "webkit", { messageHandlers: { openclawDeviceSettings: { postMessage } } });
  setProperty(window, "__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  return postMessage;
}

describe("ConfigPage native iOS notification guidance", () => {
  it.each([
    ["granted", "Granted", true, "phone", "This iPhone", ""],
    ["denied", "Denied", true, "phone", "This iPhone", ""],
    ["notDetermined", "Not determined", false, "phone", "This iPhone", ""],
    ["granted", "Granted", true, "pad", "This iPad", "/control"],
  ] as const)(
    "shows native %s (%s) with delivery=%s on %s",
    async (permission, permissionLabel, enabled, formFactor, deviceLabel, basePath) => {
      const snapshot = iosSnapshot(permission, enabled);
      snapshot.device.formFactor = formFactor;
      const postMessage = installIosBridge(snapshot);
      const { page, nativeDeviceSettings, nativeNotifications, webPush } =
        await mountNotifications(basePath);
      expect(nativeDeviceSettings?.snapshot?.device.platform).toBe("ios");
      expect(nativeDeviceSettings?.snapshot?.app?.notificationsEnabled).toBe(enabled);
      expect(nativeNotifications).toBeNull();
      expect(webPush.snapshot.permission).toBe("install-required");
      expect(postMessage.mock.calls).toEqual([[{ type: "status" }]]);
      expect(page.textContent).not.toContain("Add to Home Screen");
      expect(page.textContent).not.toContain("Browser support");
      expect(page.textContent).not.toContain("Browser push notifications");
      expect(page.textContent).toContain(permissionLabel);
      expect(page.textContent).toContain(enabled ? "Enabled" : "Disabled");
      expect(page.querySelector(`a[href="${basePath}/settings/device"]`)?.textContent).toContain(
        deviceLabel,
      );
      expect(
        page.querySelector(`a[href="${basePath}/settings/device/permissions"]`)?.textContent,
      ).toContain("Device permissions");
    },
  );

  it("waits for native settings and refreshes permission and delivery from host snapshots", async () => {
    const postMessage = installIosBridge(undefined);
    const { page, nativeDeviceSettings } = await mountNotifications();
    expect(nativeDeviceSettings?.snapshot).toBeNull();
    expect(page.textContent).toContain("Waiting for settings from the app");
    expect(page.textContent).not.toContain("Add to Home Screen");
    expect(page.textContent).not.toContain("Granted");
    expect(page.textContent).not.toContain("Enabled");
    window.dispatchEvent(
      new CustomEvent("openclaw:native-device-settings-changed", {
        detail: iosSnapshot("granted", true),
      }),
    );
    await settleLitElement(page);
    expect(nativeDeviceSettings?.snapshot?.device.platform).toBe("ios");
    expect(postMessage.mock.calls).toEqual([[{ type: "status" }]]);
    expect(page.textContent).not.toContain("Add to Home Screen");
    expect(page.textContent).toContain("Granted");
    expect(page.textContent).toContain("Enabled");
    window.dispatchEvent(
      new CustomEvent("openclaw:native-device-settings-changed", {
        detail: iosSnapshot("denied", false, 2),
      }),
    );
    await settleLitElement(page);
    expect(page.textContent).toContain("Denied");
    expect(page.textContent).toContain("Disabled");
    expect(page.textContent).not.toContain("Granted");
    expect(page.textContent).not.toContain("Enabled");
  });

  it("does not invent a delivery or permission state when the native snapshot omits them", async () => {
    const snapshot = iosSnapshot();
    delete snapshot.app;
    snapshot.permissions.entries = [];
    installIosBridge(snapshot);
    const { page } = await mountNotifications();
    expect(page.textContent).toContain("Unavailable");
    expect(page.textContent).not.toContain("Granted");
    expect(page.textContent).not.toContain("Enabled");
    expect(page.textContent).not.toContain("Add to Home Screen");
  });

  it("routes native settings clicks without reloading and leaves modified clicks to the browser", async () => {
    installIosBridge(iosSnapshot());
    const { page, navigate } = await mountNotifications("/control");
    for (const [route, href] of [
      ["device", "/control/settings/device"],
      ["device-permissions", "/control/settings/device/permissions"],
    ] as const) {
      const link = page.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;
      expect(wasNavigationHandled(page, link)).toBe(true);
      expect(navigate).toHaveBeenLastCalledWith(route);
      navigate.mockClear();
      for (const modifier of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
        { button: 1 },
      ]) {
        expect(wasNavigationHandled(page, link, modifier)).toBe(false);
      }
      expect(navigate).not.toHaveBeenCalled();
      expect(link.getAttribute("href")).toBe(href);
    }
  });

  it("keeps normal href navigation when native settings callbacks are not provided", () => {
    const container = document.createElement("div");
    render(
      renderNotificationsSection({
        connected: false,
        nativeDeviceSettings: iosSnapshot(),
        deviceSettingsHref: "/settings/device",
        devicePermissionsHref: "/settings/device/permissions",
      }),
      container,
    );
    const links = container.querySelectorAll<HTMLAnchorElement>("a");
    expect(links).toHaveLength(2);
    for (const link of links) expect(wasNavigationHandled(container, link)).toBe(false);
  });

  it("keeps Home Screen instructions in non-standalone iOS Safari", async () => {
    const { page, webPush, nativeDeviceSettings, nativeNotifications } = await mountNotifications();
    expect(nativeDeviceSettings).toBeNull();
    expect(nativeNotifications).toBeNull();
    expect(webPush.snapshot.permission).toBe("install-required");
    expect(page.textContent).toContain("Add to Home Screen");
    expect(page.textContent).toContain("Browser support");
  });

  it("keeps installed Safari on the supported Web Push path", async () => {
    setProperty(navigator, "standalone", true);
    setProperty(navigator, "serviceWorker", { getRegistration: async () => undefined });
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: "granted" });
    const { page, webPush, nativeDeviceSettings } = await mountNotifications();
    // run awaits runtime construction; offline client means no permission or network action.
    await webPush.run({ kind: "test" });
    await settleLitElement(page);
    expect(nativeDeviceSettings).toBeNull();
    expect(webPush.snapshot).toMatchObject({ supported: true, permission: "granted" });
    expect(page.textContent).not.toContain("Add to Home Screen");
    expect(page.textContent).toContain("Browser support");
    expect(page.textContent).toContain("Available");
    expect(page.textContent).toContain("Granted");
  });

  it("keeps the Mac notifications bridge on the native path", async () => {
    setProperty(navigator, "userAgent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    setProperty(navigator, "platform", "MacIntel");
    setProperty(navigator, "maxTouchPoints", 0);
    const postMessage = vi.fn();
    setProperty(window, "webkit", { messageHandlers: { openclawNotifications: { postMessage } } });
    setProperty(window, "__OPENCLAW_NATIVE_NOTIFICATIONS__", { permission: "granted", test: null });
    const { page, nativeNotifications } = await mountNotifications();
    expect(nativeNotifications?.snapshot.permission).toBe("granted");
    expect(page.textContent).not.toContain("Add to Home Screen");
    expect(page.textContent).not.toContain("Browser support");
    expect(page.textContent).toContain("Granted");
    expect(page.querySelector("button")?.textContent).toContain("Send test");
    expect(postMessage.mock.calls).toEqual([[{ type: "status" }]]);
  });
});
