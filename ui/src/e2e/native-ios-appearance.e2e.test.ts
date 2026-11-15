import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createNativeEmbedLayoutMethodResponses } from "./native-embed-fixtures.test-support.ts";
import { installNativeEmbed } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native iOS Dashboard appearance" });

declare global {
  interface Window {
    nativeAppearanceFrames: string[];
  }
}

suite.define(() => {
  for (const device of [
    { formFactor: "phone", width: 390, height: 844, mode: "dark" },
    { formFactor: "pad", width: 1024, height: 1366, mode: "light" },
  ] as const) {
    it(`keeps embedded ${device.formFactor} pages native in ${device.mode} without changing web preferences`, async () => {
      await suite.withPage(
        { viewport: device, colorScheme: device.mode, hasTouch: true, serviceWorkers: "block" },
        async ({ page, context }) => {
          await installNativeEmbed(page, { platform: "ios", formFactor: device.formFactor });
          const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
          const saved = {
            theme: "manuscript",
            themeMode: "light",
            accent: "#d4af37",
            fontUi: "lora",
            fontChat: "lora",
          };
          await page.addInitScript(
            ({ key, settings }) => {
              localStorage.setItem(key, JSON.stringify(settings));
              window.nativeAppearanceFrames = [];
              const sample = () => {
                const theme = document.documentElement?.dataset.theme;
                if (theme && !window.nativeAppearanceFrames.includes(theme)) {
                  window.nativeAppearanceFrames.push(theme);
                }
                requestAnimationFrame(sample);
              };
              requestAnimationFrame(sample);
            },
            { key: settingsKey, settings: saved },
          );
          const gateway = await installMockGateway(page, {
            operatorScopes: ["operator.admin", "operator.read", "operator.write"],
            methodResponses: createNativeEmbedLayoutMethodResponses(),
          });
          await page.goto(new URL("automations", suite.server.baseUrl).toString());
          await waitForControlUiRoute(page, { routeId: "cron" });
          const job = page.getByText("Healthy automation", { exact: true }).first();
          await job.waitFor();
          const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [job], {
            animations: "disabled",
          });
          await writeFile(
            path.join(suite.artifactDir, `${device.formFactor}-automations.png`),
            frame.png,
          );
          const appearance = () =>
            page.evaluate(() => {
              const style = getComputedStyle(document.documentElement);
              return {
                mode: document.documentElement.dataset.themeMode,
                theme: document.documentElement.dataset.theme,
                background: style.getPropertyValue("--bg").trim(),
                font: getComputedStyle(document.body).fontFamily,
              };
            });
          await expect.poll(appearance).toMatchObject({
            mode: device.mode,
            theme: device.mode,
            background: device.mode === "dark" ? "#0b0c11" : "#f6f7f9",
          });
          expect((await appearance()).font).not.toContain("Lora");
          expect(await page.evaluate(() => window.nativeAppearanceFrames)).toEqual([device.mode]);
          await page.goto(new URL("settings/talk", suite.server.baseUrl).toString());
          await waitForControlUiRoute(page, { routeId: "talk" });
          await expect.poll(appearance).toMatchObject({ mode: device.mode, theme: device.mode });
          const opposite = device.mode === "dark" ? "light" : "dark";
          await page.emulateMedia({ colorScheme: opposite });
          await expect.poll(appearance).toMatchObject({ mode: opposite, theme: opposite });
          expect(
            await page.evaluate(
              (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
              settingsKey,
            ),
          ).toMatchObject(saved);
          expect(await gateway.getRequests("themes.set")).toEqual([]);
          expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
          await page.goto(new URL("settings/appearance", suite.server.baseUrl).toString());
          await waitForControlUiRoute(page, { routeId: "appearance" });
          const hint = page.getByText(/This app follows Device → Appearance instead/);
          await hint.waitFor();
          const appearanceFrame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".shell"),
            [hint],
            { animations: "disabled" },
          );
          await writeFile(
            path.join(suite.artifactDir, `${device.formFactor}-appearance.png`),
            appearanceFrame.png,
          );

          // A normal browser sharing the same storage must still render the selected theme.
          const browser = await context.newPage();
          await installMockGateway(browser, {
            operatorScopes: ["operator.admin", "operator.read"],
          });
          await browser.goto(new URL("settings/talk", suite.server.baseUrl).toString());
          await waitForControlUiRoute(browser, { routeId: "talk" });
          await expect
            .poll(() => browser.locator("html").getAttribute("data-theme"))
            .toBe("manuscript-light");
          expect(
            await browser.locator("body").evaluate((body) => getComputedStyle(body).fontFamily),
          ).toContain("Lora");
        },
      );
    });
  }
});
