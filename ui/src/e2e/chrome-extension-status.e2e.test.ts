import path from "node:path";
import { expect, it } from "vitest";
import { createChromeExtensionSetupResult } from "../test-helpers/chrome-extension-setup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createNativeDeviceSettingsSnapshot } from "../test-helpers/native-device-settings.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chrome extension installation status" });

suite.define(() => {
  it.each(["current", "v2026.9.5"])(
    "shows installed Chrome with the %s Mac bridge",
    async (appVersion) => {
      const artifactDir = createControlUiE2eArtifactDir("chrome-extension-status");
      await suite.withPage(
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
              nativeHostRegistered: true,
              installRequested: false,
              installedProfiles: 1,
              discoveredProfiles: 1,
              awaitingApproval: false,
              automaticBootstrapSupported: true,
            },
            nextAction: "check_connection",
          });
          await page.addInitScript(
            ({
              snapshot: initialSnapshot,
              setupResult: initialSetupResult,
              appVersion: nativeAppVersion,
            }) => {
              const messages: Array<{ type: string; action?: string }> = [];
              Object.assign(window, {
                __OPENCLAW_NATIVE_DEVICE_SETTINGS__: initialSnapshot,
                chromeExtensionMessages: messages,
                chromeExtensionEnabledProfiles: 1,
                webkit: {
                  messageHandlers: {
                    openclawDeviceSettings: {
                      postMessage(message: { type: string; action?: string }) {
                        messages.push(message);
                        if (message.type === "chrome-extension-setup") {
                          if (nativeAppVersion !== "current" || message.action !== "inspect") {
                            return Promise.reject(new Error("Unexpected setup action."));
                          }
                          const enabled = Reflect.get(window, "chromeExtensionEnabledProfiles");
                          return Promise.resolve({
                            ...initialSetupResult,
                            installation: {
                              ...initialSetupResult.installation,
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
                        return Promise.resolve(initialSnapshot);
                      },
                    },
                  },
                },
              });
            },
            { snapshot, setupResult, appVersion },
          );
          await installMockGateway(page, { operatorScopes: ["operator.read"] });
          await page.goto(`${suite.server.baseUrl}settings/device`);
          const card = page.locator(".settings-section").filter({
            has: page.locator(".device-extension-setup"),
          });
          await page.locator(".device-extension-setup").waitFor();
          await card.scrollIntoViewIfNeeded();
          const messages = () =>
            page.evaluate(() => Reflect.get(window, "chromeExtensionMessages"));
          if (appVersion === "v2026.9.5") {
            await expect.poll(() => card.textContent()).toContain("Status unavailable");
            expect(await messages()).toEqual([
              { type: "status" },
              { type: "chrome-extension-status" },
            ]);
            await page.screenshot({
              path: path.join(artifactDir, "chrome-extension-unavailable.png"),
              animations: "disabled",
              fullPage: false,
            });
            await card.getByRole("button", { name: "Set up Chrome on this device" }).click();
          }
          await expect.poll(() => card.textContent()).toContain("Installed");
          expect(
            await card.getByRole("button", { name: "Set up Chrome on this device" }).count(),
          ).toBe(0);
          expect(await card.getByRole("button", { name: "Refresh setup status" }).count()).toBe(1);
          expect(await messages()).toEqual(
            appVersion === "v2026.9.5"
              ? [
                  { type: "status" },
                  { type: "chrome-extension-status" },
                  { type: "install-chrome-extension" },
                ]
              : [{ type: "status" }, { type: "chrome-extension-setup", action: "inspect" }],
          );
          if (appVersion === "current") {
            await page.evaluate(() => {
              Reflect.set(window, "chromeExtensionEnabledProfiles", 0);
              window.dispatchEvent(new Event("focus"));
            });
            await expect.poll(() => card.textContent()).toContain("installed but not enabled");
            expect(await messages()).toEqual([
              { type: "status" },
              { type: "chrome-extension-setup", action: "inspect" },
              { type: "status" },
              { type: "chrome-extension-setup", action: "inspect" },
            ]);
            expect(
              await card.getByRole("button", { name: "Set up Chrome on this device" }).count(),
            ).toBe(0);
          }
          await page.screenshot({
            path: path.join(artifactDir, "chrome-extension-installed.png"),
            animations: "disabled",
            fullPage: false,
          });
        },
      );
    },
  );
});
