import { expect, it } from "vitest";
import { createChromeExtensionSetupResult } from "../test-helpers/chrome-extension-setup.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createNativeDeviceSettingsSnapshot } from "../test-helpers/native-device-settings.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chrome extension installation status" });

suite.define(() => {
  it.each(["current", "v2026.9.5"])(
    "checks Chrome only after an explicit action with the %s Mac bridge",
    async (appVersion) =>
      suite.withPage(
        { viewport: { width: 1440, height: 1000 }, colorScheme: "light" },
        async ({ page }) => {
          await installNativeWebChrome(page);
          const snapshot = createNativeDeviceSettingsSnapshot();
          if (appVersion === "v2026.9.5") {
            snapshot.device.appVersion = "2026.9.5";
            delete snapshot.browser.chromeSetupActions;
          }
          const setupResult = createChromeExtensionSetupResult({
            phase: "waiting_for_connection",
            installation: {
              ...createChromeExtensionSetupResult().installation,
              nativeHostRegistered: true,
              installedProfiles: 1,
              discoveredProfiles: 1,
            },
            nextAction: "check_connection",
          });
          await page.addInitScript(
            ({ settings, result, version }) => {
              const messages: Array<{ type: string; action?: string }> = [];
              const postMessage = (message: { type: string; action?: string }) => {
                messages.push(message);
                if (message.type === "chrome-extension-setup") {
                  if (version !== "current" || message.action !== "inspect") {
                    return Promise.reject(new Error("Unexpected setup action."));
                  }
                  const enabled = Reflect.get(window, "chromeExtensionEnabledProfiles");
                  return Promise.resolve({
                    ...result,
                    installation: {
                      ...result.installation,
                      discoveredProfiles: enabled,
                      awaitingApproval: enabled === 0,
                    },
                    phase: enabled ? "waiting_for_connection" : "needs_browser_action",
                    nextAction: enabled ? "check_connection" : "approve_extension",
                  });
                }
                if (message.type === "chrome-extension-status") {
                  return Promise.reject(new Error("Invalid device settings request."));
                }
                if (message.type === "install-chrome-extension") {
                  return Promise.resolve({
                    nativeHostRegistered: true,
                    installRequested: false,
                    discoveredProfiles: 1,
                  });
                }
                return Promise.resolve(settings);
              };
              Object.assign(window, {
                __OPENCLAW_NATIVE_DEVICE_SETTINGS__: settings,
                chromeExtensionMessages: messages,
                chromeExtensionEnabledProfiles: 1,
                webkit: { messageHandlers: { openclawDeviceSettings: { postMessage } } },
              });
            },
            { settings: snapshot, result: setupResult, version: appVersion },
          );
          await installMockGateway(page, { operatorScopes: ["operator.read"] });
          await page.goto(`${suite.server.baseUrl}settings/device`);
          const extensionSetup = page.locator(".device-extension-setup");
          const card = page.locator(".settings-section").filter({ has: extensionSetup });
          await extensionSetup.waitFor();
          await card.scrollIntoViewIfNeeded();
          const setup = card.getByRole("button", { name: "Set up Chrome on this device" });
          const refresh = card.getByRole("button", { name: "Refresh setup status" });
          const messages = () =>
            page.evaluate(() => Reflect.get(window, "chromeExtensionMessages"));
          const status = { type: "status" };
          const inspect = { type: "chrome-extension-setup", action: "inspect" };
          expect(await messages()).toEqual([status]);
          expect(await card.textContent()).not.toMatch(/Installed|Status unavailable/u);
          await (appVersion === "v2026.9.5" ? setup : refresh).click();
          await expect.poll(() => card.textContent()).toContain("Installed");
          expect(await setup.count()).toBe(1);
          expect(await refresh.count()).toBe(appVersion === "current" ? 1 : 0);
          expect(await messages()).toEqual(
            appVersion === "v2026.9.5"
              ? [status, { type: "install-chrome-extension" }]
              : [status, inspect],
          );
          if (appVersion === "current") {
            await page.evaluate(() => {
              Reflect.set(window, "chromeExtensionEnabledProfiles", 0);
              window.dispatchEvent(new Event("focus"));
            });
            await expect.poll(messages).toEqual([status, inspect, status]);
            expect(await card.textContent()).not.toContain("installed but not enabled");
            await refresh.click();
            await expect.poll(() => card.textContent()).toContain("installed but not enabled");
            expect(await messages()).toEqual([status, inspect, status, inspect]);
            expect(await setup.count()).toBe(1);
          }
        },
      ),
  );
});
