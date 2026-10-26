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
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DevicePage } from "./device-page.tsx";
import { DevicePermissionsPage } from "./permissions-page.tsx";

type Snapshot = NativeDeviceSettingsSnapshot;
type Capability = NativeDeviceSettingsCapability;
type MacSnapshot = ReturnType<typeof createNativeDeviceSettingsSnapshot>;
type CookieSync = MacSnapshot["browser"]["cookieSync"];
const deviceTag = "openclaw-device-page";
const permissionsTag = "openclaw-device-permissions-page";
const hostingTitle = "Keep OpenClaw running when the app is closed";
const unmounts = new WeakMap<HTMLElement, () => void>();

function createCapability(snapshot: Snapshot | null = createNativeDeviceSettingsSnapshot()) {
  const listeners = new Set<(value: Snapshot) => void>();
  const capability = {
    snapshot,
    initialSnapshot: Promise.resolve(snapshot),
    subscribe(listener: (value: Snapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: vi.fn<Capability["set"]>(),
    requestPermission: vi.fn(),
    openSystemSettings: vi.fn(),
    openPanel: vi.fn(),
    checkForUpdates: vi.fn(),
    setupChromeExtension: vi.fn().mockResolvedValue(createChromeExtensionSetupResult()),
    installChromeExtension: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  } satisfies Capability;
  return {
    capability,
    settle(this: void, index: number, next = createNativeDeviceSettingsSnapshot(), error?: Error) {
      capability.snapshot = next;
      capability.set.mock.calls[index]?.[2]?.(error);
      listeners.forEach((listener) => listener(next));
    },
    publish(this: void, next: Snapshot) {
      capability.snapshot = next;
      listeners.forEach((listener) => listener(next));
    },
  };
}

async function mount(
  tag: typeof deviceTag | typeof permissionsTag,
  nativeDeviceSettings: Capability | null,
) {
  const context = { nativeDeviceSettings } as ApplicationContext;
  const fixture = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(
    () => createComponent(tag === deviceTag ? DevicePage : DevicePermissionsPage, {}),
    { wrapper: fixture.wrapper },
  );
  flush();
  const page = mounted.container.querySelector<HTMLElement>(tag)!;
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

function addDomain(page: HTMLElement, value: string) {
  typeInput(row(page, "Domains").querySelector("input")!, value);
  flush();
  row(page, "Domains")
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flush();
}

function toggleInput(scope: HTMLElement) {
  return scope.querySelector<HTMLInputElement>("input.settings-toggle__input")!;
}

function profileInput(page: HTMLElement) {
  return row(page, "Target profile").querySelector("input")!;
}

function clickRow(page: HTMLElement, title: string) {
  row(page, title).querySelector("button")!.click();
}

async function setup(
  snapshot: Snapshot | null = createNativeDeviceSettingsSnapshot(),
  tag: typeof deviceTag | typeof permissionsTag = deviceTag,
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
    reply(this: void, index: number, snapshot: MacSnapshot, expected: string) {
      fixture.settle(index, snapshot);
      flush();
      expect(input.value).toBe(expected);
    },
  };
}

function cookieSnapshot(values: Partial<CookieSync>) {
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

beforeEach(() => i18n.setLocale("en"));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("displays desktop worker failures without unsupported controls", async () => {
  const snapshot = createTauriDeviceSettingsSnapshot("windows");
  const { capability, page } = await setup({
    ...snapshot,
    desktopSharing: { state: "error", detail: "Install the OpenClaw CLI to share this desktop." },
  });
  expect(row(page, "Desktop sharing").textContent).toContain("authenticated local VNC server");
  expect(page.textContent).not.toContain("Computer Control");
  expect(row(page, "Desktop sharing status").textContent).toContain("Unavailable");
  expect(page.textContent).toContain("Install the OpenClaw CLI");
  const permissions = await mount(permissionsTag, capability);
  expect(permissions.querySelector("input.settings-toggle__input")).toBeNull();
  expect(permissions.textContent).not.toContain("Location access");
});
it("switches the advertised Mac experience and follows the native owner's saved value", async () => {
  const { page, set, render } = await setup();
  const title = "Native experience (Experimental)";
  const experience = row(page, title);
  expect(toggleInput(experience).checked).toBe(false);
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
  const title = hostingTitle;
  const hosting = row(page, title);
  expect(toggleInput(hosting).checked).toBe(false);
  toggle(page, title, true);
  expect(set).toHaveBeenCalledExactlyOnceWith("app.keepGatewayRunning", true, expect.any(Function));
  await waitForSolid(() => expect(toggleInput(hosting).hasAttribute("aria-disabled")).toBe(true));
  const saved = createNativeDeviceSettingsSnapshot();
  saved.app.keepGatewayRunning = true;
  settle(0, saved);
  await waitForSolid(() => expect(toggleInput(hosting).hasAttribute("aria-disabled")).toBe(false));
  expect(toggleInput(hosting).checked).toBe(true);
  toggle(page, title, false);
  expect(set).toHaveBeenLastCalledWith("app.keepGatewayRunning", false, expect.any(Function));
  settle(1, saved, new Error("Gateway did not become ready."));
  await waitForSolid(() => expect(toggleInput(hosting).hasAttribute("aria-disabled")).toBe(false));
  expect(toggleInput(hosting).checked).toBe(true);
  await waitForSolid(() =>
    expect(hosting.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not change Gateway hosting. Gateway did not become ready.",
    ),
  );
  toggle(page, title, false);
  flush();
  expect(hosting.querySelector('[role="alert"]')).toBeNull();
  await waitForSolid(() => expect(toggleInput(hosting).hasAttribute("aria-disabled")).toBe(true));
  expect(row(page, title)).toBe(hosting);
  // Native Cancel returns the accepted snapshot unchanged.
  settle(2, saved);
  await waitForSolid(() => expect(toggleInput(hosting).hasAttribute("aria-disabled")).toBe(false));
  expect(toggleInput(hosting).checked).toBe(true);
  expect(row(page, title)).toBe(hosting);
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

it("leaves a held Gateway confirmation without delaying profile cleanup or leaking its error", async () => {
  const { capability, page, settle } = await setup();
  const title = hostingTitle;
  toggle(page, title, true);
  flush();
  typeInput(profileInput(page), "pending-profile");
  unmountPage(page);
  expectCookieWrite(capability, "targetProfile", "pending-profile");

  const next = await mount(deviceTag, capability);
  settle(0, createNativeDeviceSettingsSnapshot(), new Error("Retired confirmation"));
  await waitForSolid(() =>
    expect(toggleInput(row(next, title)).hasAttribute("aria-disabled")).toBe(false),
  );
  expect(row(next, title).querySelector('[role="alert"]')).toBeNull();
});

it("shows native desktop state and reconciles Keep computer awake with the native owner", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  snapshot.desktopAvailability = { state: "locked" };
  const { page, set, render } = await setup(snapshot);
  const hosting = row(page, "Keep computer awake");
  expect(hosting.textContent).toContain("Manual lock and logout");
  expect(row(page, "Desktop availability").textContent).toContain("Locked");
  expect(set).not.toHaveBeenCalled();
  toggle(page, "Keep computer awake", true);
  expect(set).toHaveBeenCalledWith("capabilities.unattendedDesktopEnabled", true);
  render({ ...snapshot, desktopAvailability: { state: "unknown" } });
  expect(toggleInput(hosting).checked).toBe(false);
  expect(row(page, "Desktop availability").textContent).toContain("Unknown");
  delete snapshot.capabilities.unattendedDesktopEnabled;
  render({ ...snapshot, desktopAvailability: { state: "unlocked" } });
  expect(row(page, "Desktop availability").textContent).toContain("Unlocked");
  expect(page.textContent).not.toContain("Keep computer awake");
});

it.each([deviceTag, permissionsTag] as const)(
  "waits for the initial native snapshot on %s",
  async (tag) => {
    const { capability } = createCapability(null);
    const waitingPage = await mount(tag, capability);
    expect(waitingPage.textContent).toContain("Waiting for settings from the app");
    expect(waitingPage.querySelector("input.settings-toggle__input")).toBeNull();
  },
);

it("gates unavailable native controls and delegates Mac panels", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  snapshot.app.debugPaneEnabled = true;
  snapshot.app.quickChatShortcut = null;
  snapshot.app.launchAtLoginAvailable = false;
  const { capability, page } = await setup(snapshot);
  expect(row(page, "Quick Chat shortcut").textContent).toContain("Not set");
  expect(toggleInput(row(page, "Launch at login")).disabled).toBe(true);
  expect(row(page, "Launch at login").textContent).toContain("requires a bundled app");
  expect(
    row(page, "Computer Control provider").querySelector<HTMLOptionElement>('option[value="cua"]')!
      .disabled,
  ).toBe(true);
  expect(row(page, "Allow Computer Control").textContent).toContain(
    "without per-action confirmation. High risk.",
  );

  for (const [title, panel] of [
    ["Quick Chat shortcut", "quick-chat-shortcut"],
    ["Browser logins", "browser-import"],
    ["Debug window", "debug"],
  ] as const) {
    clickRow(page, title);
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
  next.capabilities.computerControlEnabled = false;
  next.browser.importAvailable = false;
  next.browser.cookieSync.available = false;
  render(next);
  expect(toggleInput(row(page, "Enable Peekaboo Bridge")).disabled).toBe(true);
  expect(page.querySelector('[aria-label="Computer Control provider"]')).toBeNull();
  expect(page.querySelector('[aria-label="Dock icon"]')).toBeNull();
  expect(page.textContent).not.toContain("Import browser logins…");
  expect(page.querySelector('[aria-label="Target profile"]')).toBeNull();
  expect(page.textContent).toContain("Cookie sync requires remote mode");
  expect(page.textContent).not.toContain("Open Debug window…");
});

it("delegates iOS toggles and device panels", async () => {
  const { capability, page, set } = await setup(createIosNativeDeviceSettingsSnapshot());
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
    clickRow(page, title);
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

it("normalizes domains and preserves newer edits through navigation and stale acknowledgements", async () => {
  const { capability, page: first, settle, render } = await setup();
  addDomain(first, " EXAMPLE.COM ");
  addDomain(first, " A.EXAMPLE.COM ");
  unmountPage(first);
  const page = await mount(deviceTag, capability);
  addDomain(page, " B.EXAMPLE.COM ");
  expectCookieWrite(capability, "domains", ["example.com", "a.example.com", "b.example.com"]);
  settle(1, cookieSnapshot({ domains: ["example.com", "a.example.com"] }));
  flush();
  page.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')?.click();
  expectCookieWrite(capability, "domains", ["a.example.com", "b.example.com"]);

  settle(3, cookieSnapshot({ domains: ["a.example.com", "b.example.com"] }));
  flush();
  render(cookieSnapshot({ domains: ["external.example.com"] }));
  expect(row(page, "Domains").textContent).toContain("external.example.com");
  expect(row(page, "Domains").textContent).not.toContain("b.example.com");
  unmountPage(page);
  const next = await mount(deviceTag, capability);
  expect(row(next, "Domains").textContent).toContain("external.example.com");
  expect(row(next, "Domains").textContent).not.toContain("b.example.com");
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
  ["screenRecording", "Screen Recording"],
  ["accessibility", "Accessibility"],
  ["eventPosting", "Event Posting"],
] as const)(
  "requests %s access and retains explicit settings recovery without assuming a prior denial",
  async (id, title) => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.permissions.entries = [{ id, status: "notDetermined" }];
    const { capability, page, render } = await setup(snapshot, permissionsTag);
    const permission = row(page, title);
    expect(permission.textContent).toContain("Not granted");
    const button = permission.querySelector("button");
    expect(button?.textContent?.trim()).toBe("Grant…");
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
    const { capability, page, set, render } = await setup(snapshot, permissionsTag);
    const permissions = page.querySelector(".settings-group")!;
    expect(
      [...permissions.querySelectorAll(".settings-row__title")].map((element) =>
        element.textContent?.trim(),
      ),
    ).toEqual(["Photos", "Contacts", "Calendars", "Reminders"]);
    for (const title of ["Photos", "Contacts"]) {
      expect(row(page, title).textContent).toContain("Limited");
      expect(
        row(page, title).querySelector(".settings-row__desc")?.textContent?.trim(),
      ).toBeTruthy();
    }
    clickRow(page, "Calendars");
    expect(capability.requestPermission).toHaveBeenCalledWith("calendars");
    clickRow(page, "Reminders");
    expect(capability.openSystemSettings).toHaveBeenCalledWith("reminders");
    expect(page.textContent).not.toContain("System-wide presence detection");
    expect(row(page, "Precise location").querySelector("input.settings-toggle__input")).toBeNull();
    expect(row(page, "Precise location").textContent).toContain("Disabled");
    const settings = row(page, "Precise location").querySelector("button")!;
    expect(settings.textContent?.trim()).toBe("Open Settings");
    settings.click();
    expect(capability.openSystemSettings).toHaveBeenCalledWith("location");
    expect(set).not.toHaveBeenCalled();

    snapshot.permissions.location.precise = true;
    render(snapshot);
    expect(row(page, "Precise location").textContent).toContain("Enabled");
    expect(row(page, "Precise location").querySelector("input.settings-toggle__input")).toBeNull();
  },
);

it("enables precision with location access and changes local location and activity preferences", async () => {
  const { page, set, render } = await setup(undefined, permissionsTag);
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
