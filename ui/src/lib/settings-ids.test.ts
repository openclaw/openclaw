import { describe, expect, it } from "vitest";
import { CONTROL_UI_SETTINGS_PAGES } from "../../../src/shared/control-ui-settings/index.ts";
import { isSettingsNavigationRouteVisible } from "../app-navigation.ts";
import { agentRouteFromPath, routeIdFromPath } from "../app-route-paths.ts";
import type { NativeDeviceSettingsCapability } from "../app/native-device-settings.ts";
import { createChromeExtensionSetupResult } from "../test-helpers/chrome-extension-setup.ts";
import { createNativeDeviceSettingsSnapshot } from "../test-helpers/native-device-settings.ts";

// Device pages appear only inside the native apps.
const nativeApp: NativeDeviceSettingsCapability = {
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

describe("Control UI settings pages", () => {
  it.each(CONTROL_UI_SETTINGS_PAGES.map((page) => [page.path, page] as const))(
    "%s is a Settings route",
    (_path, page) => {
      const routeId = routeIdFromPath(page.path);
      expect(routeId).not.toBeNull();
      expect(isSettingsNavigationRouteVisible(routeId!, true, nativeApp)).toBe(true);
      if (page.agent) {
        const panel = page.agentPanel ? `/${page.agentPanel}` : "";
        expect(agentRouteFromPath(`${page.path}/main${panel}`)).toMatchObject({
          agentId: "main",
          invalidPanel: false,
        });
      }
    },
  );
});
