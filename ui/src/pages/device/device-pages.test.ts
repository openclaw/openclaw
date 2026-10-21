/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
} from "../../app/native-device-settings.ts";
import { i18n } from "../../i18n/index.ts";
import { createChromeExtensionSetupResult } from "../../test-helpers/chrome-extension-setup.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
  createTauriDeviceSettingsSnapshot,
} from "../../test-helpers/native-device-settings.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { DevicePage } from "./device-page.tsx";
import { DevicePermissionsPage } from "./permissions-page.tsx";

const providers: HTMLElement[] = [];
const unmounts = new WeakMap<HTMLElement, () => void>();

function createCapability(
  snapshot: NativeDeviceSettingsSnapshot | null = createNativeDeviceSettingsSnapshot(),
) {
  const listeners = new Set<(value: NativeDeviceSettingsSnapshot) => void>();
  const capability = {
    snapshot,
    subscribe(listener: (value: NativeDeviceSettingsSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: vi.fn<NativeDeviceSettingsCapability["set"]>(),
    requestPermission: vi.fn(),
    openSystemSettings: vi.fn(),
    openPanel: vi.fn(),
    checkForUpdates: vi.fn(),
    setupChromeExtension: vi.fn().mockResolvedValue(createChromeExtensionSetupResult()),
    installChromeExtension: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  } satisfies NativeDeviceSettingsCapability;
  return {
    capability,
    settle(this: void, index: number, next = createNativeDeviceSettingsSnapshot(), error?: Error) {
      capability.snapshot = next;
      capability.set.mock.calls[index]?.[2]?.(error);
      listeners.forEach((listener) => listener(next));
    },
    publish(this: void, next: NativeDeviceSettingsSnapshot) {
      capability.snapshot = next;
      listeners.forEach((listener) => listener(next));
    },
  };
}

async function mount(
  tag: "openclaw-device-page" | "openclaw-device-permissions-page",
  nativeDeviceSettings: NativeDeviceSettingsCapability | null,
) {
  const context = { nativeDeviceSettings } as ApplicationContext;
  const provider = document.createElement("div");
  document.body.append(provider);
  providers.push(provider);
  const fixture = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(
    () => createComponent(tag === "openclaw-device-page" ? DevicePage : DevicePermissionsPage, {}),
    { container: provider, wrapper: fixture.wrapper },
  );
  flush();
  const page = provider.querySelector<HTMLElement>(tag)!;
  unmounts.set(page, mounted.unmount);
  return page;
}

function unmountPage(page: HTMLElement) {
  unmounts.get(page)?.();
}

function row(page: HTMLElement, title: string): HTMLElement {
  const match = [...page.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!match) {
    throw new Error(`Missing row: ${title}`);
  }
  return match;
}

function toggle(page: HTMLElement, title: string, checked: boolean) {
  const element = toggleInput(row(page, title));
  element.checked = checked;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function typeInput(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeDomain(page: HTMLElement, value: string) {
  typeInput(row(page, "Domains").querySelector("input")!, value);
}

function submitDomain(page: HTMLElement) {
  row(page, "Domains")
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function toggleInput(scope: HTMLElement) {
  return scope.querySelector<HTMLInputElement>("input.settings-toggle__input")!;
}

function profileInput(page: HTMLElement) {
  return row(page, "Target profile").querySelector("input")!;
}

function titles(scope: Element) {
  return [...scope.querySelectorAll(".settings-row__title")].map((element) =>
    element.textContent?.trim(),
  );
}

async function setup(
  snapshot: NativeDeviceSettingsSnapshot | null = createNativeDeviceSettingsSnapshot(),
  tag: "openclaw-device-page" | "openclaw-device-permissions-page" = "openclaw-device-page",
) {
  const native = createCapability(snapshot);
  const page = await mount(tag, native.capability);
  const render = (value: NativeDeviceSettingsSnapshot) => {
    native.publish(value);
    flush();
  };
  return { ...native, page, set: native.capability.set, render };
}

async function mountProfileEditor() {
  vi.useFakeTimers();
  const fixture = await setup();
  const input = profileInput(fixture.page);
  return {
    ...fixture,
    input,
    async type(this: void, value: string, delay = 400) {
      typeInput(input, value);
      await vi.advanceTimersByTimeAsync(delay);
    },
    reply(
      this: void,
      index: number,
      snapshot: ReturnType<typeof cookieSnapshot>,
      expected: string,
    ) {
      fixture.settle(index, snapshot);
      flush();
      expect(input.value).toBe(expected);
    },
  };
}

function cookieSnapshot(
  values: Partial<ReturnType<typeof createNativeDeviceSettingsSnapshot>["browser"]["cookieSync"]>,
) {
  const snapshot = createNativeDeviceSettingsSnapshot();
  Object.assign(snapshot.browser.cookieSync, values);
  return snapshot;
}

function expectCookieWrite(
  capability: ReturnType<typeof createCapability>["capability"],
  field: "domains" | "targetProfile",
  value: string | string[],
) {
  expect(capability.set).toHaveBeenLastCalledWith(
    `browser.cookieSync.${field}`,
    value,
    expect.any(Function),
  );
}

function addDomain(page: HTMLElement, value: string) {
  typeDomain(page, value);
  flush();
  submitDomain(page);
  flush();
}

beforeEach(() => i18n.setLocale("en"));
afterEach(async () => {
  providers.splice(0).forEach((provider) => provider.remove());
  await Promise.resolve();
  flush();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["linux", "windows"] as const)(
  "edits %s desktop sharing and displays worker failures without unsupported controls",
  async (platform) => {
    const snapshot = createTauriDeviceSettingsSnapshot(platform);
    const { capability, page, set, render } = await setup(snapshot);
    expect(page.textContent).toContain("This computer");
    expect(row(page, "Desktop sharing").textContent).toContain("authenticated local VNC server");
    expect(row(page, "Desktop sharing status").textContent).toContain("Running");
    expect(page.textContent).not.toContain("Computer Control");
    toggle(page, "Desktop sharing", false);
    expect(set).toHaveBeenCalledExactlyOnceWith("capabilities.desktopSharingEnabled", false);
    render({
      ...snapshot,
      capabilities: { desktopSharingEnabled: false },
      desktopSharing: { state: "off" },
    });
    expect(toggleInput(row(page, "Desktop sharing")).checked).toBe(false);
    render({
      ...snapshot,
      desktopSharing: {
        state: "error",
        detail: "Install the OpenClaw CLI to share this desktop.",
      },
    });
    expect(row(page, "Desktop sharing status").textContent).toContain("Unavailable");
    expect(page.textContent).toContain("Install the OpenClaw CLI");
    const permissions = await mount("openclaw-device-permissions-page", capability);
    expect(permissions.querySelector("input.settings-toggle__input")).toBeNull();
    expect(permissions.textContent).not.toContain("Location access");
  },
);
it("switches the advertised Mac experience and follows the native owner's saved value", async () => {
  const { page, set, render } = await setup();
  const title = "Native experience (Experimental)";
  const experience = row(page, title);
  expect(toggleInput(experience).checked).toBe(false);
  expect(experience.textContent).toContain("When off, use the Web experience");
  toggle(page, title, true);
  expect(set).toHaveBeenCalledExactlyOnceWith("app.nativeExperienceEnabled", true);
  const saved = createNativeDeviceSettingsSnapshot();
  saved.app.nativeExperienceEnabled = true;
  render(saved);
  expect(toggleInput(experience).checked).toBe(true);
  toggle(page, title, false);
  expect(set).toHaveBeenLastCalledWith("app.nativeExperienceEnabled", false);
  delete saved.app.nativeExperienceEnabled;
  render(saved);
  expect(page.textContent).not.toContain(title);
});

it("switches Gateway hosting only when available and follows the native owner's result", async () => {
  const { page, set, settle, render } = await setup();
  const title = "Keep OpenClaw running when the app is closed";
  const hosting = row(page, title);
  expect(hosting.previousElementSibling).toBe(row(page, "Launch at login"));
  expect(hosting.textContent).toContain(
    "Runs the Gateway as a background service so channels and automations keep working after you quit OpenClaw.",
  );
  expect(toggleInput(hosting).checked).toBe(false);
  toggle(page, title, true);
  expect(set).toHaveBeenCalledExactlyOnceWith("app.keepGatewayRunning", true, expect.any(Function));
  flush();
  expect(toggleInput(hosting).disabled).toBe(true);
  const saved = createNativeDeviceSettingsSnapshot();
  saved.app.keepGatewayRunning = true;
  settle(0, saved);
  flush();
  expect(toggleInput(hosting).checked).toBe(true);
  toggle(page, title, false);
  expect(set).toHaveBeenLastCalledWith("app.keepGatewayRunning", false, expect.any(Function));
  settle(1, saved, new Error("Gateway did not become ready."));
  flush();
  expect(toggleInput(hosting).checked).toBe(true);
  expect(hosting.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not change Gateway hosting. Gateway did not become ready.",
  );
  saved.app.keepGatewayRunningAvailable = false;
  render(saved);
  expect(toggleInput(hosting).disabled).toBe(true);
  set.mockClear();
  hosting.click();
  expect(set).not.toHaveBeenCalled();
  delete saved.app.keepGatewayRunning;
  render(saved);
  expect(page.textContent).not.toContain(title);
});

it("shows native desktop state and reconciles Keep computer awake with the native owner", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  const { page, set, render } = await setup({
    ...snapshot,
    capabilities: { ...snapshot.capabilities, unattendedDesktopEnabled: false },
    desktopAvailability: { state: "locked" },
  });
  const hosting = row(page, "Keep computer awake");
  expect(hosting.textContent).toContain("between jobs");
  expect(hosting.textContent).toContain("Manual lock and logout");
  expect(row(page, "Desktop availability").textContent).toContain("Locked");
  expect(set).not.toHaveBeenCalled();
  toggle(page, "Keep computer awake", true);
  expect(set).toHaveBeenCalledWith("capabilities.unattendedDesktopEnabled", true);
  render({
    ...snapshot,
    capabilities: { ...snapshot.capabilities, unattendedDesktopEnabled: false },
    desktopAvailability: { state: "unknown" },
  });
  expect(toggleInput(hosting).checked).toBe(false);
  expect(row(page, "Desktop availability").textContent).toContain("Unknown");
  const capabilities = { ...snapshot.capabilities };
  delete capabilities.unattendedDesktopEnabled;
  render({ ...snapshot, capabilities, desktopAvailability: { state: "unlocked" } });
  expect(row(page, "Desktop availability").textContent).toContain("Unlocked");
  expect(page.textContent).not.toContain("Keep computer awake");
});

it("leaves Chrome data untouched on entry and focus until explicit refresh", async () => {
  const { capability, page } = await setup();
  const chrome = page.querySelector<HTMLElement>("openclaw-native-chrome-setup")!;
  flush();
  expect(capability.setupChromeExtension).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("focus"));
  flush();
  expect(capability.setupChromeExtension).not.toHaveBeenCalled();
  const refresh = [...chrome.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Refresh setup status",
  )!;
  refresh.click();
  await vi.waitFor(() => expect(chrome.textContent).toContain("Setup required on this device"));
  expect(capability.setupChromeExtension).toHaveBeenCalledExactlyOnceWith("inspect");
  expect(capability.installChromeExtension).not.toHaveBeenCalled();
});
it.each(["openclaw-device-page", "openclaw-device-permissions-page"] as const)(
  "shows an app-only state without a bridge and waits for the initial snapshot on %s",
  async (tag) => {
    const browserPage = await mount(tag, null);
    expect(browserPage.textContent).toContain("only available inside the OpenClaw app");
    expect(browserPage.querySelector("input.settings-toggle__input")).toBeNull();
    const { capability } = createCapability(null);
    const waitingPage = await mount(tag, capability);
    expect(waitingPage.textContent).toContain("Waiting for settings from the app");
    expect(waitingPage.querySelector("input.settings-toggle__input")).toBeNull();
  },
);

it("renders local settings and delegates native toggles and panels without Gateway access", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  snapshot.app.debugPaneEnabled = true;
  snapshot.app.quickChatShortcut = null;
  snapshot.app.launchAtLoginAvailable = false;
  const { capability, page, set } = await setup(snapshot);
  expect(page.querySelector(".page-title")?.textContent).toContain("This Mac");
  expect(page.querySelector<HTMLAnchorElement>(".page-subtitle a")?.href).toBe(
    "https://docs.openclaw.ai/platforms/macos",
  );
  expect(row(page, "Quick Chat shortcut").textContent).toContain("Not set");
  const iconStyles = row(page, "Dock icon").querySelector("select")!;
  expect(iconStyles.value).toBe("paper");
  expect([...iconStyles.options].map((option) => option.textContent?.trim())).toEqual([
    "Original",
    "Heritage",
    "Clawmark",
    "Origami",
    "Pincer",
    "Open C",
  ]);
  iconStyles.value = "origami";
  iconStyles.dispatchEvent(new Event("change", { bubbles: true }));
  expect(set).toHaveBeenCalledWith("app.iconStyle", "origami");
  expect(toggleInput(row(page, "Launch at login")).disabled).toBe(true);
  expect(row(page, "Launch at login").textContent).toContain("requires a bundled app");
  expect(
    row(page, "Computer Control provider").querySelector<HTMLOptionElement>('option[value="cua"]')!
      .disabled,
  ).toBe(true);
  expect(row(page, "Allow Computer Control").textContent).toContain(
    "without per-action confirmation. High risk.",
  );

  toggle(page, "Show Dock icon", false);
  expect(set).toHaveBeenCalledWith("app.showDockIcon", false);
  for (const [title, panel] of [
    ["Quick Chat shortcut", "quick-chat-shortcut"],
    ["Browser logins", "browser-import"],
    ["Debug window", "debug"],
  ] as const) {
    row(page, title).querySelector("button")!.click();
    expect(capability.openPanel).toHaveBeenCalledWith(panel);
  }
});

it("renders new native snapshots and removes controls whose native capabilities became unavailable", async () => {
  const { page, render } = await setup();
  const next = createNativeDeviceSettingsSnapshot();
  next.app.iconStyle = {
    selectedId: "origami",
    available: [{ id: "origami", name: "Origami" }],
  };
  render(next);
  const iconStyles = row(page, "Dock icon").querySelector("select")!;
  expect(iconStyles).toMatchObject({ value: "origami", options: { length: 1 } });
  delete next.app.iconStyle;
  next.app.quickChatShortcut = "⌘K";
  next.app.showDockIcon = false;
  next.capabilities.computerControlEnabled = false;
  next.browser.importAvailable = false;
  next.browser.cookieSync.available = false;
  render(next);
  expect(row(page, "Quick Chat shortcut").textContent).toContain("⌘K");
  expect(toggleInput(row(page, "Show Dock icon")).checked).toBe(false);
  expect(toggleInput(row(page, "Enable Peekaboo Bridge")).disabled).toBe(true);
  expect(page.querySelector('[aria-label="Computer Control provider"]')).toBeNull();
  expect(page.querySelector('[aria-label="Dock icon"]')).toBeNull();
  expect(page.textContent).not.toContain("Import browser logins…");
  expect(page.querySelector('[aria-label="Target profile"]')).toBeNull();
  expect(page.textContent).toContain("Cookie sync requires remote mode");
  expect(page.textContent).not.toContain("Open Debug window…");
});

it("renders only published iOS settings and delegates app preferences and device panels", async () => {
  const { capability, page, set } = await setup(createIosNativeDeviceSettingsSnapshot());
  expect(page.querySelector(".page-title")?.textContent).toContain("This iPhone");
  expect(titles(page)).toEqual([
    "Appearance",
    "Notifications",
    "Allow Camera",
    "Keep awake",
    "Health summaries",
    "Diagnostics",
    "Licenses",
    "About",
    "Apple Watch",
  ]);
  const appearance = row(page, "Appearance").querySelector("select")!;
  expect(appearance.value).toBe("system");
  expect([...appearance.options].map((option) => option.value)).toEqual([
    "system",
    "light",
    "dark",
  ]);
  appearance.value = "dark";
  appearance.dispatchEvent(new Event("change", { bubbles: true }));
  expect(set).toHaveBeenCalledWith("app.appearance", "dark");
  for (const [title, key] of [
    ["Notifications", "app.notificationsEnabled"],
    ["Keep awake", "capabilities.keepAwakeEnabled"],
    ["Health summaries", "capabilities.healthSummaryEnabled"],
  ] as const) {
    toggle(page, title, true);
    expect(set).toHaveBeenCalledWith(key, true);
  }
  for (const [title, panel] of [
    ["Diagnostics", "diagnostics"],
    ["Licenses", "licenses"],
    ["About", "about"],
    ["Apple Watch", "watch"],
  ] as const) {
    row(page, title).querySelector("button")!.click();
    expect(capability.openPanel).toHaveBeenCalledWith(panel);
  }
});

it("removes absent device families and fields and hides unavailable health summaries", async () => {
  const { page, render } = await setup(createIosNativeDeviceSettingsSnapshot());
  const next: NativeDeviceSettingsSnapshot = {
    ...createIosNativeDeviceSettingsSnapshot(),
    app: { notificationsEnabled: false },
    capabilities: { healthSummaryAvailable: false, healthSummaryEnabled: true },
  };
  render(next);
  expect(page.querySelector('[aria-label="Appearance"]')).toBeNull();
  expect(page.textContent).not.toContain("Health summaries");
  expect(toggleInput(row(page, "Notifications")).checked).toBe(false);
  delete next.app;
  delete next.capabilities;
  render(next);
  expect(page.querySelectorAll("select, input")).toHaveLength(0);
  expect(page.querySelectorAll(".settings-group")).toHaveLength(1);
  expect(row(page, "Diagnostics").querySelector("button")).not.toBeNull();
});

it("normalizes and deduplicates added cookie hostnames and removes a selected hostname", async () => {
  const { capability, page } = await setup();
  for (const hostname of ["  EXAMPLE.COM ", "  ACCOUNTS.EXAMPLE.ORG  "]) {
    addDomain(page, hostname);
  }
  expectCookieWrite(capability, "domains", ["example.com", "accounts.example.org"]);
  page.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')?.click();
  expectCookieWrite(capability, "domains", ["accounts.example.org"]);
});

it("preserves newer domain edits across an older native acknowledgement", async () => {
  const { capability, page, settle, render } = await setup();
  for (const hostname of ["a.example.com", "b.example.com"]) {
    addDomain(page, hostname);
  }

  settle(0, cookieSnapshot({ domains: ["example.com", "a.example.com"] }));
  flush();
  page.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')?.click();
  expectCookieWrite(capability, "domains", ["a.example.com", "b.example.com"]);

  settle(2, cookieSnapshot({ domains: ["a.example.com", "b.example.com"] }));
  flush();
  render(cookieSnapshot({ domains: ["external.example.com"] }));
  expect(row(page, "Domains").textContent).toContain("external.example.com");
  expect(row(page, "Domains").textContent).not.toContain("b.example.com");
});

it("debounces profile typing and flushes the latest edit once when leaving the page", async () => {
  const { capability, page, input, type } = await mountProfileEditor();
  for (const value of ["work", "work-browser"]) {
    await type(value, 200);
  }
  expect(capability.set).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(capability.set).toHaveBeenCalledExactlyOnceWith(
    "browser.cookieSync.targetProfile",
    "work-browser",
    expect.any(Function),
  );
  typeInput(input, "personal-browser");
  unmountPage(page);
  expectCookieWrite(capability, "targetProfile", "personal-browser");
  await vi.advanceTimersByTimeAsync(500);
  expect(capability.set).toHaveBeenCalledTimes(2);
});

it("preserves the latest sent profile across an older native acknowledgement", async () => {
  const { capability, settle, render, input, type, reply } = await mountProfileEditor();
  for (const value of ["first-profile", "second-profile"]) {
    await type(value);
  }
  reply(0, cookieSnapshot({ targetProfile: "first-profile" }), "second-profile");

  await type(`${input.value}-final`);
  expectCookieWrite(capability, "targetProfile", "second-profile-final");
  settle(2, cookieSnapshot({ targetProfile: "second-profile-final" }));
  flush();
  render(cookieSnapshot({ targetProfile: "external-profile" }));
  expect(input.value).toBe("external-profile");
});

it("preserves pending cookie sync edits across page navigation", async () => {
  vi.useFakeTimers();
  const { capability, page: first, publish, settle } = await setup();
  typeDomain(first, "b.example.com");
  flush();
  submitDomain(first);
  typeInput(profileInput(first), "pending-profile");
  unmountPage(first);

  const second = await mount("openclaw-device-page", capability);
  typeDomain(second, "c.example.com");
  flush();
  submitDomain(second);
  expectCookieWrite(capability, "domains", ["example.com", "b.example.com", "c.example.com"]);
  const secondProfile = profileInput(second);
  typeInput(secondProfile, `${secondProfile.value}-remote`);
  unmountPage(second);
  expectCookieWrite(capability, "targetProfile", "pending-profile-remote");

  const acknowledged = cookieSnapshot({
    domains: ["example.com", "b.example.com", "c.example.com"],
    targetProfile: "pending-profile-remote",
  });
  settle(2, acknowledged);
  settle(3, acknowledged);
  publish(cookieSnapshot({ domains: ["external.example.com"], targetProfile: "external-profile" }));
  const third = await mount("openclaw-device-page", capability);
  expect(row(third, "Domains").textContent).toContain("external.example.com");
  expect(row(third, "Domains").textContent).not.toContain("b.example.com");
  expect(profileInput(third).value).toBe("external-profile");
});

it("settles cancelled cookie edits after navigation without reusing rejected values", async () => {
  vi.useFakeTimers();
  const { capability, page: first, set, settle } = await setup();
  typeDomain(first, "rejected.example.com");
  flush();
  submitDomain(first);
  typeInput(profileInput(first), "rejected-profile");
  unmountPage(first);
  const second = await mount("openclaw-device-page", capability);
  settle(0);
  settle(1);
  flush();
  expect(row(second, "Domains").textContent).not.toContain("rejected.example.com");
  expect(profileInput(second).value).toBe("default");
  second.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')!.click();
  expect(set.mock.calls.at(-1)?.slice(0, 2)).toEqual(["browser.cookieSync.domains", []]);
});

it("settles native profile normalization without losing a newer unsent edit", async () => {
  const { input, type, reply } = await mountProfileEditor();
  await type(" work ");
  const normalized = cookieSnapshot({ targetProfile: "work" });
  reply(0, normalized, "work");
  await type("older");
  typeInput(input, "newer");
  reply(1, normalized, "newer");
  await vi.advanceTimersByTimeAsync(400);
  reply(2, normalized, "work");
});

it("keeps a newer equal-valued profile pending when the first request settles", async () => {
  const { settle, input, type } = await mountProfileEditor();
  for (const value of ["first", "middle", "first"]) {
    await type(value);
  }
  settle(0, cookieSnapshot({ targetProfile: "first" }));
  settle(1);
  flush();
  expect(input.value).toBe("first");
  settle(2);
  flush();
  expect(input.value).toBe("default");
});

it.each([
  ["screenRecording", "Screen Recording", "notDetermined", "Not granted", "Grant…"],
  ["accessibility", "Accessibility", "notDetermined", "Not granted", "Grant…"],
  ["eventPosting", "Event Posting", "notDetermined", "Not granted", "Grant…"],
] as const)(
  "requests %s access and retains explicit settings recovery without assuming a prior denial",
  async (id, title, status, label, action) => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.permissions.entries = [{ id, status }];
    const { capability, page, render } = await setup(snapshot, "openclaw-device-permissions-page");
    const permission = row(page, title);
    expect(permission.textContent).toContain(label);
    const button = permission.querySelector("button");
    expect(button?.textContent?.trim()).toBe(action);
    expect(capability.requestPermission).not.toHaveBeenCalled();
    button!.click();
    expect(capability.requestPermission).toHaveBeenCalledExactlyOnceWith(id);
    expect(capability.openSystemSettings).not.toHaveBeenCalled();
    const recovery = permission.querySelector<HTMLButtonElement>(".settings-permission-recovery");
    expect(recovery?.textContent?.trim()).toBe("Open System Settings…");
    recovery!.click();
    expect(capability.openSystemSettings).toHaveBeenCalledExactlyOnceWith(id);
    expect(capability.requestPermission).toHaveBeenCalledTimes(1);
    snapshot.permissions.entries = [{ id, status: "granted" }];
    render(snapshot);
    expect(permission.textContent).toContain("Granted");
    expect(permission.querySelector("button")).toBeNull();
  },
);

it.each([false, undefined])(
  "keeps iOS permission order and system-owned precision read-only (editable: %s)",
  async (preciseEditable) => {
    const snapshot = createIosNativeDeviceSettingsSnapshot();
    snapshot.permissions.location.preciseEditable = preciseEditable;
    snapshot.permissions.entries = [
      { id: "photos", status: "limited" },
      { id: "contacts", status: "limited" },
      { id: "calendars", status: "notDetermined" },
      { id: "reminders", status: "denied" },
    ];
    snapshot.permissions.location.precise = false;
    const { capability, page, set, render } = await setup(
      snapshot,
      "openclaw-device-permissions-page",
    );
    expect(titles(page.querySelector(".settings-group")!)).toEqual([
      "Photos",
      "Contacts",
      "Calendars",
      "Reminders",
    ]);
    for (const title of ["Photos", "Contacts"]) {
      expect(row(page, title).textContent).toContain("Limited");
      expect(
        row(page, title).querySelector(".settings-row__desc")?.textContent?.trim(),
      ).toBeTruthy();
    }
    row(page, "Calendars").querySelector("button")!.click();
    expect(capability.requestPermission).toHaveBeenCalledWith("calendars");
    row(page, "Reminders").querySelector("button")!.click();
    expect(capability.openSystemSettings).toHaveBeenCalledWith("reminders");
    expect(page.textContent).not.toContain("System-wide presence detection");
    expect(row(page, "Precise location").querySelector("input.settings-toggle__input")).toBeNull();
    expect(row(page, "Precise location").textContent).toContain("Disabled");
    const settings = row(page, "Precise location").querySelector("button")!;
    expect(settings.textContent?.trim()).toBe("Open Settings");
    settings.click();
    expect(capability.openSystemSettings).toHaveBeenCalledWith("location");
    expect(set).not.toHaveBeenCalled();

    render({
      ...snapshot,
      permissions: {
        ...snapshot.permissions,
        location: { ...snapshot.permissions.location, precise: true },
      },
    });
    expect(row(page, "Precise location").textContent).toContain("Enabled");
    expect(row(page, "Precise location").querySelector("input.settings-toggle__input")).toBeNull();
  },
);

it("enables precision with location access and changes local location and activity preferences", async () => {
  const { page, set, render } = await setup(undefined, "openclaw-device-permissions-page");
  expect(toggleInput(row(page, "Precise location")).disabled).toBe(true);
  row(page, "Location access")
    .querySelector<HTMLInputElement>('input.settings-segmented__input[value="whileUsing"]')!
    .click();
  expect(set).toHaveBeenCalledWith("permissions.location.mode", "whileUsing");
  const next = createNativeDeviceSettingsSnapshot();
  next.permissions.location.mode = "whileUsing";
  render(next);
  expect(toggleInput(row(page, "Precise location")).disabled).toBe(false);
  toggle(page, "Precise location", true);
  expect(set).toHaveBeenCalledWith("permissions.location.precise", true);
  toggle(page, "System-wide presence detection", true);
  expect(set).toHaveBeenCalledWith("capabilities.activeComputerPresenceEnabled", true);
  expect(row(page, "System-wide presence detection").textContent).toContain(
    "Shares only idle duration, never keys, pointer positions, app names, or window titles.",
  );
});
