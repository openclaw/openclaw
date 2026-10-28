import { expect, it } from "vitest";
import {
  isSessionsHubRoute,
  isSettingsNavigationRoute,
  normalizeSidebarEntries,
  visibleSettingsNavigationGroups,
} from "./app-navigation.ts";
import type { NativeDeviceSettingsCapability as Device } from "./app/native-device-settings.ts";
import { getStaticCommandPaletteCatalogItems } from "./components/command-palette-catalog-search.ts";
import { settingsNavigationOwnerRoute } from "./lib/settings-navigation.ts";
import { findSettingsSearchBlocks } from "./pages/config/settings-search.ts";
import { createChromeExtensionSetupResult } from "./test-helpers/chrome-extension-setup.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
  createTauriDeviceSettingsSnapshot,
} from "./test-helpers/native-device-settings.ts";

it.each([true, false])("shows device settings only with the capability, admin=%s", (canAdmin) => {
  const capability: Device = {
    snapshot: createNativeDeviceSettingsSnapshot(),
    initialSnapshot: Promise.resolve(createNativeDeviceSettingsSnapshot()),
    subscribe: () => () => undefined,
    set: () => Promise.resolve(),
    requestPermission: () => undefined,
    openSystemSettings: () => undefined,
    openPanel: () => undefined,
    checkForUpdates: () => undefined,
    setupChromeExtension: async (action) => createChromeExtensionSetupResult({ action }),
    refresh: () => undefined,
    dispose: () => undefined,
  };
  const searchOptions = { schema: null, value: null, uiHints: {}, canAdmin };
  const expectSearch = (query: string, nativeDeviceSettings: Device | null, routeId?: string) =>
    expect(findSettingsSearchBlocks({ ...searchOptions, query, nativeDeviceSettings })).toEqual(
      routeId ? expect.arrayContaining([expect.objectContaining({ routeId })]) : [],
    );
  const deviceGroup = (snapshot: Device["snapshot"]) =>
    visibleSettingsNavigationGroups(canAdmin, { ...capability, snapshot })[1];
  const catalog = (device: Device | null = null) =>
    getStaticCommandPaletteCatalogItems(canAdmin, device).map((item) => item.action);
  const browserGroups = visibleSettingsNavigationGroups(canAdmin);
  const browserRoutes = new Set(browserGroups.flatMap((group) => group.routes));
  expect(browserRoutes.has("updates")).toBe(canAdmin);
  expect(browserRoutes.has("channels")).toBe(true);
  expect(browserRoutes.has("communications")).toBe(canAdmin);
  expectSearch("Check for updates", capability, "updates");
  expect(catalog(capability)).toContain("nav:updates");
  expect(browserGroups.some((group) => group.labelKey === "nav.settingsGroupDevice")).toBe(false);
  expect(deviceGroup(capability.snapshot)).toEqual({
    labelKey: "nav.settingsGroupDevice",
    routes: ["device", "device-permissions"],
  });
  for (const platform of ["linux", "windows"] as const) {
    const desktopCapability = {
      ...capability,
      snapshot: createTauriDeviceSettingsSnapshot(platform),
    };
    expect(deviceGroup(desktopCapability.snapshot)).toEqual({
      labelKey: "nav.settingsGroupThisComputer",
      routes: ["device"],
    });
    expectSearch("Desktop sharing", desktopCapability, "device");
    expectSearch("Precise location", desktopCapability);
  }
  expect(deviceGroup(null)?.labelKey).toBe("nav.settingsGroupThisDevice");
  const iosSnapshot = createIosNativeDeviceSettingsSnapshot();
  for (const [formFactor, labelKey] of [
    ["phone", "nav.settingsGroupThisIPhone"],
    ["pad", "nav.settingsGroupThisIPad"],
    [undefined, "nav.settingsGroupThisDevice"],
  ] as const) {
    iosSnapshot.device.formFactor = formFactor;
    expect(deviceGroup(iosSnapshot)?.labelKey).toBe(labelKey);
  }
  const iosCapability = { ...capability, snapshot: iosSnapshot };
  for (const [query, routeId, ios] of [
    ["Health summaries", "device", true],
    ["Apple Watch", "device", true],
    ["Contacts", "device-permissions", true],
    ["Photos", "device-permissions", true],
    ["Use speakerphone", "talk", true],
    ["Talk in the background", "talk", true],
    ["Dock icon", "device", false],
    ["Launch at login", "device", false],
    ["Quick Chat", "device", false],
    ["Cookie sync", "device", false],
    ["System-wide presence detection", "device-permissions", false],
  ] as const) {
    expectSearch(query, ios ? iosCapability : capability, routeId);
    expectSearch(query, ios ? capability : iosCapability);
    expectSearch(query, null);
    if (ios) {
      expectSearch(query, { ...capability, snapshot: null });
    }
  }
  iosSnapshot.capabilities!.healthSummaryAvailable = false;
  delete iosSnapshot.voice.speakerphoneEnabled;
  iosSnapshot.permissions.entries = iosSnapshot.permissions.entries.filter(
    (entry) => entry.id !== "contacts",
  );
  for (const query of ["Health summaries", "Use speakerphone", "Contacts"]) {
    expectSearch(query, iosCapability);
  }
  for (const route of ["device", "device-permissions"] as const) {
    expect(catalog()).not.toContain(`nav:${route}`);
    expect(catalog(capability)).toContain(`nav:${route}`);
  }
});
it("treats worktrees as a sessions hub tab", () => {
  expect(isSessionsHubRoute("sessions")).toBe(true);
  expect(isSessionsHubRoute("worktrees")).toBe(true);
  expect(isSessionsHubRoute("chat")).toBe(false);
});

it("keeps model setup as a settings subpage without a sidebar entry", () => {
  expect(isSettingsNavigationRoute("claws")).toBe(false);
  expect(isSettingsNavigationRoute("model-setup")).toBe(true);
  expect(settingsNavigationOwnerRoute("model-setup")).toBe("model-providers");
});

const opaqueIds = ["plugin:reports/daily/team:summary", "plugin:reports/日报 summary"];
const validEntries = ["route:usage", "session:agent:main:test", "route:cron"];
const invalidEntries = ["route:tasks", "route:worktrees", "session:", "usage", 7];
it.each([
  [
    ["route:workboard", "workboard:ops"],
    ["plugin:workboard/workboard", "plugin:workboard/board-ops"],
  ],
  [opaqueIds, opaqueIds],
  [[...validEntries, validEntries[0], ...invalidEntries], validEntries],
  [["plugin:reports/", "plugin:/report"], []],
  [[], []],
  [undefined, null],
])("normalizes persisted entries %j to %j", (input, expected) => {
  expect(normalizeSidebarEntries(input)).toEqual(expected);
});
