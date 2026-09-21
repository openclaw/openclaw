import path from "node:path";
import { expect, it } from "vitest";
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
          await page.addInitScript(
            ({ snapshot, appVersion: nativeAppVersion }) => {
              const messages: string[] = [];
              Object.assign(window, {
                __OPENCLAW_NATIVE_DEVICE_SETTINGS__: snapshot,
                chromeExtensionMessages: messages,
                webkit: {
                  messageHandlers: {
                    openclawDeviceSettings: {
                      postMessage(message: { type: string }) {
                        messages.push(message.type);
                        if (message.type === "chrome-extension-status") {
                          if (nativeAppVersion === "v2026.9.5") {
                            return Promise.reject(new Error("Invalid device settings request."));
                          }
                          return Promise.resolve({
                            nativeHostRegistered: true,
                            installRequested: false,
                            installedProfiles: 1,
                            discoveredProfiles: 1,
                          });
                        }
                        if (message.type === "install-chrome-extension") {
                          return Promise.resolve({
                            nativeHostRegistered: true,
                            installRequested: false,
                            discoveredProfiles: 1,
                          });
                        }
                        return Promise.resolve(snapshot);
                      },
                    },
                  },
                },
              });
            },
            { snapshot: createNativeDeviceSettingsSnapshot(), appVersion },
          );
          await installMockGateway(page, { operatorScopes: ["operator.read"] });
          await page.goto(`${suite.server.baseUrl}settings/device`);
          const card = page.locator(".settings-section").filter({
            has: page.locator(".device-extension-setup"),
          });
          await page.locator(".device-extension-setup").waitFor();
          await card.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: path.join(artifactDir, "chrome-extension.png"),
            animations: "disabled",
            fullPage: false,
          });
          if (appVersion === "v2026.9.5") {
            await expect.poll(() => card.textContent()).toContain("Status unavailable");
            expect(
              await page.evaluate(() => Reflect.get(window, "chromeExtensionMessages")),
            ).not.toContain("install-chrome-extension");
            await card.getByRole("button", { name: "Set up Chrome on this Mac" }).click();
          }
          await expect.poll(() => card.textContent()).toContain("Installed");
          expect(
            await card.getByRole("button", { name: "Set up Chrome on this Mac" }).count(),
          ).toBe(0);
          expect(await card.getByRole("button", { name: "Check again" }).count()).toBe(1);
          expect(
            await page.evaluate(() => Reflect.get(window, "chromeExtensionMessages")),
          ).toContain("chrome-extension-status");
          const messages = await page.evaluate(() =>
            Reflect.get(window, "chromeExtensionMessages"),
          );
          expect(
            messages.filter((type: string) => type === "install-chrome-extension"),
          ).toHaveLength(appVersion === "v2026.9.5" ? 1 : 0);
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
