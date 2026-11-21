import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
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
    nativeAppearanceBackgrounds: string[];
  }
}

suite.define(() => {
  it.each(["malformed", "unreadable"] as const)(
    "applies the light iOS palette before runtime with %s web settings",
    async (storage) => {
      await suite.withPage({ colorScheme: "light", serviceWorkers: "block" }, async ({ page }) => {
        await installNativeEmbed(page, { platform: "ios", formFactor: "pad" });
        await page.addInitScript((storageMode) => {
          if (storageMode === "malformed") {
            localStorage.setItem("openclaw.control.settings.v1", "{");
          } else {
            Object.defineProperty(window, "localStorage", {
              get() {
                throw new DOMException("Storage unavailable", "SecurityError");
              },
            });
          }
        }, storage);
        // The document-start script must set the palette without runtime correcting it.
        await page.route("**/*", (route) =>
          route.request().resourceType() === "script" ? route.abort() : route.fallback(),
        );
        await page.goto(new URL("automations", suite.server.baseUrl).toString());
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
        expect(
          await page.locator("html").evaluate((root) => getComputedStyle(root).backgroundColor),
        ).toBe("rgb(246, 247, 249)");
      });
    },
  );

  it("prepares the ordinary browser offline shell without the iOS palette", async () => {
    await suite.withPage({ serviceWorkers: "allow" }, async ({ page, context }) => {
      // Network-isolated Chromium can report offline even when loopback works.
      if (!(await page.evaluate(() => navigator.onLine))) {
        const protocol = await context.newCDPSession(page);
        await protocol.send("Network.overrideNetworkState", {
          offline: false,
          latency: 1,
          downloadThroughput: -1,
          uploadThroughput: -1,
          connectionType: "ethernet",
        });
      }
      const nativePaletteRequests: string[] = [];
      context.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith("/themes/native-ios.css")) {
          nativePaletteRequests.push(request.url());
        }
      });
      await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read"],
        methodResponses: createNativeEmbedLayoutMethodResponses(),
      });
      await page.goto(new URL("automations", suite.server.baseUrl).toString());
      await waitForControlUiRoute(page, { routeId: "cron" });
      // Wait for the real worker to finish preparing its cache, not just to register.
      await expect
        .poll(
          async () =>
            page.evaluate(async (base) => {
              const active = (await navigator.serviceWorker.getRegistration())?.active;
              return (
                active?.state === "activated" &&
                (await caches.match(new URL("__offline_shell__", base).href)) !== undefined
              );
            }, suite.server.baseUrl),
          { timeout: 20_000 },
        )
        .toBe(true);
      expect(
        await page.evaluate(async () => {
          const keys = await Promise.all(
            (await caches.keys()).map(async (name) => {
              return (await caches.open(name)).keys();
            }),
          );
          return keys
            .flat()
            .some((request) => new URL(request.url).pathname.endsWith("/themes/native-ios.css"));
        }),
      ).toBe(false);
      expect(nativePaletteRequests).toEqual([]);
    });
  });

  for (const device of [
    { formFactor: "phone", width: 390, height: 844, mode: "dark" },
    { formFactor: "pad", width: 1024, height: 1366, mode: "light" },
  ] as const) {
    it(`keeps embedded ${device.formFactor} pages native in ${device.mode} without changing web preferences`, async () => {
      await suite.withPage(
        { viewport: device, colorScheme: device.mode, hasTouch: true, serviceWorkers: "block" },
        async ({ page, context }) => {
          const paletteRequests: string[] = [];
          page.on("request", (request) => {
            if (new URL(request.url()).pathname.endsWith("/themes/native-ios.css")) {
              paletteRequests.push(request.url());
            }
          });
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
              window.nativeAppearanceBackgrounds = [];
              const sample = () => {
                const theme = document.documentElement?.dataset.theme;
                if (theme && !window.nativeAppearanceFrames.includes(theme)) {
                  window.nativeAppearanceFrames.push(theme);
                }
                if (theme) {
                  const color = getComputedStyle(document.documentElement).backgroundColor;
                  if (!window.nativeAppearanceBackgrounds.includes(color)) {
                    window.nativeAppearanceBackgrounds.push(color);
                  }
                }
                requestAnimationFrame(sample);
              };
              requestAnimationFrame(sample);
            },
            { key: settingsKey, settings: saved },
          );
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "cron.list"],
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
          expect(await page.evaluate(() => window.nativeAppearanceBackgrounds)).toEqual([
            device.mode === "dark" ? "rgb(11, 12, 17)" : "rgb(246, 247, 249)",
          ]);
          expect(paletteRequests).toHaveLength(1);
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
          const browserPalettes: string[] = [];
          browser.on("request", (request) => {
            if (new URL(request.url()).pathname.endsWith("/themes/native-ios.css")) {
              browserPalettes.push(request.url());
            }
          });
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
          expect(browserPalettes).toEqual([]);
        },
      );
    });
  }
});
