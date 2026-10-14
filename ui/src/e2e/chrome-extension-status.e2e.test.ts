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
    "checks Chrome only after an explicit action with the %s Mac bridge",
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
          expect(await messages()).toEqual([{ type: "status" }]);
          expect(await card.textContent()).not.toContain("Installed");
          expect(await card.textContent()).not.toContain("Status unavailable");
          if (appVersion === "v2026.9.5") {
            await card.getByRole("button", { name: "Set up Chrome on this device" }).click();
          } else {
            await card.getByRole("button", { name: "Refresh setup status" }).click();
          }
          await expect.poll(() => card.textContent()).toContain("Installed");
          expect(
            await card.getByRole("button", { name: "Set up Chrome on this device" }).count(),
          ).toBe(1);
          expect(await card.getByRole("button", { name: "Refresh setup status" }).count()).toBe(
            appVersion === "current" ? 1 : 0,
          );
          expect(await messages()).toEqual(
            appVersion === "v2026.9.5"
              ? [{ type: "status" }, { type: "install-chrome-extension" }]
              : [{ type: "status" }, { type: "chrome-extension-setup", action: "inspect" }],
          );
          if (appVersion === "current") {
            await page.evaluate(() => {
              Reflect.set(window, "chromeExtensionEnabledProfiles", 0);
              window.dispatchEvent(new Event("focus"));
            });
            await expect
              .poll(messages)
              .toEqual([
                { type: "status" },
                { type: "chrome-extension-setup", action: "inspect" },
                { type: "status" },
              ]);
            expect(await card.textContent()).not.toContain("installed but not enabled");
            await card.getByRole("button", { name: "Refresh setup status" }).click();
            await expect.poll(() => card.textContent()).toContain("installed but not enabled");
            expect(await messages()).toEqual([
              { type: "status" },
              { type: "chrome-extension-setup", action: "inspect" },
              { type: "status" },
              { type: "chrome-extension-setup", action: "inspect" },
            ]);
            expect(
              await card.getByRole("button", { name: "Set up Chrome on this device" }).count(),
            ).toBe(1);
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

  it("keeps unknown install state through blocked inspect and a connected verify", async () => {
    const artifactDir = createControlUiE2eArtifactDir("chrome-extension-blocked");
    const blockedInstallation = {
      nativeHostRegistered: true,
      installRequested: false,
      installedProfiles: 0,
      discoveredProfiles: 0,
      awaitingApproval: false,
      automaticBootstrapSupported: true,
      discoveryBlocked: true,
    };
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, colorScheme: "light" },
      async ({ page }) => {
        await installNativeWebChrome(page);
        const snapshot = createNativeDeviceSettingsSnapshot();
        const inspectResult = createChromeExtensionSetupResult({
          phase: "waiting_for_connection",
          reason: "profile_inspection_blocked",
          installation: blockedInstallation,
          nextAction: "check_connection",
        });
        // A connected verify proves the relay, not the installation count, so
        // the same blocked installation fact must cross into its response.
        const verifyResult = createChromeExtensionSetupResult({
          action: "verify",
          phase: "ready",
          reason: "connected",
          installation: blockedInstallation,
          connection: { state: "connected", extensionVersion: "2.3.0" },
          nextAction: "none",
        });
        await page.addInitScript(
          ({ snapshot: initialSnapshot, inspect: inspectPayload, verify: verifyPayload }) => {
            Object.assign(window, {
              __OPENCLAW_NATIVE_DEVICE_SETTINGS__: initialSnapshot,
              webkit: {
                messageHandlers: {
                  openclawDeviceSettings: {
                    postMessage(message: { type: string; action?: string }) {
                      if (
                        message.type === "chrome-extension-setup" &&
                        message.action === "inspect"
                      ) {
                        return Promise.resolve(inspectPayload);
                      }
                      if (
                        message.type === "chrome-extension-setup" &&
                        message.action === "verify"
                      ) {
                        return Promise.resolve(verifyPayload);
                      }
                      return Promise.resolve(initialSnapshot);
                    },
                  },
                },
              },
            });
          },
          {
            snapshot,
            inspect: inspectResult,
            verify: verifyResult,
          },
        );
        await installMockGateway(page, { operatorScopes: ["operator.read"] });
        await page.goto(`${suite.server.baseUrl}settings/device`);
        const card = page.locator(".settings-section").filter({
          has: page.locator(".device-extension-setup"),
        });
        await page.locator(".device-extension-setup").waitFor();
        await card.scrollIntoViewIfNeeded();

        await card.getByRole("button", { name: "Refresh setup status" }).click();
        await expect.poll(() => card.textContent()).toContain("Status unavailable");
        expect(await card.textContent()).toContain("Chrome profile files are unreadable");
        expect(await card.textContent()).not.toContain("Not installed");
        await page.screenshot({
          path: path.join(artifactDir, "chrome-extension-blocked-inspect.png"),
          animations: "disabled",
          fullPage: false,
        });

        await card.getByRole("button", { name: "Verify connection" }).click();
        await expect.poll(() => card.textContent()).toContain("Extension connected on this device");
        // The regression: connection success must not erase the blocked fact.
        expect(await card.textContent()).toContain("Status unavailable");
        expect(await card.textContent()).not.toContain("Not installed");
        await page.screenshot({
          path: path.join(artifactDir, "chrome-extension-blocked-verified.png"),
          animations: "disabled",
          fullPage: false,
        });
      },
    );
  });
});
