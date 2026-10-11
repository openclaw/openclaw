/* @vitest-environment jsdom */
import { afterEach, describe, it, vi } from "vitest";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { projectNativeDeviceSettings } from "./application-native.ts";
import { verifyApplicationProjection } from "./application-test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native application projections", () => {
  it("projects native settings replies after the owner validates them", async () => {
    await verifyApplicationProjection({
      create: () => {
        const snapshot = createNativeDeviceSettingsSnapshot();
        vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
        vi.stubGlobal("webkit", {
          messageHandlers: {
            openclawDeviceSettings: {
              postMessage: async () => ({
                ...snapshot,
                app: { ...snapshot.app, showDockIcon: false },
              }),
            },
          },
        });
        const source = createNativeDeviceSettingsCapability()!;
        return {
          source,
          update: () =>
            new Promise<void>((resolve, reject) => {
              source.set("app.showDockIcon", false, (error) => (error ? reject(error) : resolve()));
            }),
          dispose: () => source.dispose(),
        };
      },
      project: projectNativeDeviceSettings,
      select: (value) => value?.app?.showDockIcon,
      initial: true,
      updated: false,
    });
  });
});
