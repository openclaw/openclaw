import { describe, expect, it } from "vitest";
import {
  isSessionsHubRoute,
  isSettingsNavigationRoute,
  normalizeSidebarEntries,
  parseSidebarEntry,
  visibleSettingsNavigationGroups,
  isSettingsNavigationRouteVisible,
} from "./app-navigation.ts";
import type { NativeDeviceSettingsCapability } from "./app/native-device-settings.ts";
import { readGatewayOperatorAccess } from "./app/operator-access.ts";
import { getStaticCommandPaletteCatalogItems } from "./components/command-palette-catalog-search.ts";
import { settingsNavigationOwnerRoute } from "./lib/settings-navigation.ts";
import { findSettingsSearchBlocks } from "./pages/config/settings-search.ts";
import { createChromeExtensionSetupResult } from "./test-helpers/chrome-extension-setup.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
  createTauriDeviceSettingsSnapshot,
} from "./test-helpers/native-device-settings.ts";

describe("sidebar entries", () => {
  it.each([true, false])("shows device settings only with the capability, admin=%s", (canAdmin) => {
    const capability: NativeDeviceSettingsCapability = {
      snapshot: createNativeDeviceSettingsSnapshot(),
      subscribe: () => () => undefined,
      set: () => undefined,
      requestPermission: () => undefined,
      openSystemSettings: () => undefined,
      openPanel: () => undefined,
      checkForUpdates: () => undefined,
      setupChromeExtension: async (action) => createChromeExtensionSetupResult({ action }),
      refresh: () => undefined,
      dispose: () => undefined,
    };
    const searchOptions = { schema: null, value: null, uiHints: {}, canAdmin };
    const search = (query: string, nativeDeviceSettings: NativeDeviceSettingsCapability | null) =>
      findSettingsSearchBlocks({ ...searchOptions, query, nativeDeviceSettings });
    const expectSearch = (
      query: string,
      device: NativeDeviceSettingsCapability | null,
      routeId?: string,
    ) => {
      expect(search(query, device)).toEqual(
        routeId ? expect.arrayContaining([expect.objectContaining({ routeId })]) : [],
      );
    };
    const deviceGroup = (snapshot: NativeDeviceSettingsCapability["snapshot"]) =>
      visibleSettingsNavigationGroups(canAdmin, { ...capability, snapshot })[1];
    const catalog = (device: NativeDeviceSettingsCapability | null = null) =>
      getStaticCommandPaletteCatalogItems(canAdmin, device).map((item) => item.action);
    expectSearch("Dock icon", null);
    expectSearch("Dock icon", capability, "device");
    expectSearch("System-wide presence detection", null);
    expectSearch("System-wide presence detection", capability, "device-permissions");
    const browserGroups = visibleSettingsNavigationGroups(canAdmin);
    const nativeGroups = visibleSettingsNavigationGroups(canAdmin, capability);
    expect(browserGroups.flatMap((group) => group.routes).includes("updates")).toBe(canAdmin);
    expect(nativeGroups.flatMap((group) => group.routes)).toContain("updates");
    expect(isSettingsNavigationRouteVisible("updates", canAdmin)).toBe(canAdmin);
    expect(isSettingsNavigationRouteVisible("updates", canAdmin, capability)).toBe(true);
    expectSearch("Check for updates", capability, "updates");
    expect(catalog(capability)).toContain("nav:updates");
    expect(browserGroups.some((group) => group.labelKey === "nav.settingsGroupDevice")).toBe(false);
    expect(nativeGroups[1]).toEqual({
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
      ["desktop", "nav.settingsGroupThisDevice"],
      [undefined, "nav.settingsGroupThisDevice"],
    ] as const) {
      iosSnapshot.device.formFactor = formFactor;
      expect(deviceGroup(iosSnapshot)?.labelKey).toBe(labelKey);
    }
    const iosCapability = { ...capability, snapshot: iosSnapshot };
    for (const [query, routeId] of [
      ["Health summaries", "device"],
      ["Apple Watch", "device"],
      ["Contacts", "device-permissions"],
      ["Photos", "device-permissions"],
      ["Use speakerphone", "talk"],
      ["Talk in the background", "talk"],
    ] as const) {
      expectSearch(query, iosCapability, routeId);
      expectSearch(query, null);
      expectSearch(query, capability);
      expectSearch(query, { ...capability, snapshot: null });
    }
    for (const query of [
      "Dock icon",
      "Launch at login",
      "Quick Chat",
      "Cookie sync",
      "System-wide presence detection",
    ]) {
      expect(search(query, capability)).not.toEqual([]);
      expectSearch(query, iosCapability);
    }
    const sparseIosSnapshot = createIosNativeDeviceSettingsSnapshot();
    sparseIosSnapshot.capabilities!.healthSummaryAvailable = false;
    delete sparseIosSnapshot.voice.speakerphoneEnabled;
    sparseIosSnapshot.permissions.entries = sparseIosSnapshot.permissions.entries.filter(
      (entry) => entry.id !== "contacts",
    );
    for (const query of ["Health summaries", "Use speakerphone", "Contacts"]) {
      expectSearch(query, { ...capability, snapshot: sparseIosSnapshot });
    }
    for (const route of ["device", "device-permissions"] as const) {
      expect(isSettingsNavigationRouteVisible(route, canAdmin)).toBe(false);
      expect(isSettingsNavigationRouteVisible(route, canAdmin, capability)).toBe(true);
      expect(browserGroups.flatMap((group) => group.routes)).not.toContain(route);
      expect(catalog()).not.toContain(`nav:${route}`);
      expect(catalog(capability)).toContain(`nav:${route}`);
    }
  });
  it("treats worktrees as a sessions hub tab", () => {
    expect(isSessionsHubRoute("sessions")).toBe(true);
    expect(isSessionsHubRoute("worktrees")).toBe(true);
    expect(isSessionsHubRoute("chat")).toBe(false);
  });

  it("preserves the shipped Workboard placement slot outside customizable routes", () => {
    expect(normalizeSidebarEntries(["route:workboard", "workboard:ops"])).toEqual([
      "plugin:workboard/workboard",
      "plugin:workboard/board-ops",
    ]);
  });

  it("keeps model setup as a settings subpage without a sidebar entry", () => {
    expect(isSettingsNavigationRoute("agents-home")).toBe(false);
    expect(isSettingsNavigationRoute("model-setup")).toBe(true);
    expect(settingsNavigationOwnerRoute("model-setup")).toBe("model-providers");
  });

  it("filters admin-only settings while preserving legacy fail-open visibility", () => {
    const nonAdminRoutes = visibleSettingsNavigationGroups(false).flatMap((group) => group.routes);
    expect(nonAdminRoutes).toContain("approvals");
    expect(nonAdminRoutes).toContain("channels");
    expect(nonAdminRoutes).not.toContain("security");
    expect(nonAdminRoutes).not.toContain("communications");

    const legacyCanAdmin = readGatewayOperatorAccess({
      hello: { auth: { role: "operator" } },
    } as Parameters<typeof readGatewayOperatorAccess>[0]).canAdmin;
    expect(legacyCanAdmin).toBe(true);
    expect(visibleSettingsNavigationGroups(legacyCanAdmin)).toEqual(
      visibleSettingsNavigationGroups(true),
    );
  });

  it("preserves opaque descriptor IDs in plugin positions", () => {
    const entries = ["plugin:reports/daily/team:summary", "plugin:reports/日报 summary"];
    expect(normalizeSidebarEntries(entries)).toEqual(entries);
    expect(parseSidebarEntry("plugin:reports/")).toBeNull();
    expect(parseSidebarEntry("plugin:/report")).toBeNull();
  });

  it("normalizes persisted entries, dropping malformed and duplicate values", () => {
    expect(
      normalizeSidebarEntries([
        "route:usage",
        "session:agent:main:test",
        "route:cron",
        "route:tasks",
        "route:usage",
        "route:worktrees",
        "session:",
        "usage",
        7,
      ]),
    ).toEqual(["route:usage", "session:agent:main:test", "route:cron"]);
    expect(normalizeSidebarEntries([])).toEqual([]);
  });

  it("falls back to null for non-list values so callers use defaults", () => {
    expect(normalizeSidebarEntries(undefined)).toBeNull();
    expect(normalizeSidebarEntries({ usage: true })).toBeNull();
    expect(normalizeSidebarEntries("route:usage")).toBeNull();
  });
});
