import { expect, it } from "vitest";
import { createThemePaletteFixture } from "../../../test/helpers/theme-fixture.ts";
import {
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Native conversation theme startup",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});
const nativeThemeModule = /\/src\/app\/native-conversation-theme\.ts(?:\?.*)?$/u;
const appearance = {
  light: createThemePaletteFixture({ background: "#fafafa", "font-sans": undefined }),
  dark: createThemePaletteFixture({ background: "#000000", "font-sans": undefined }),
};

suite.define(() => {
  it.each([
    undefined,
    { platform: "ios", formFactor: "phone", surface: "conversation" },
    { platform: "macos", formFactor: "desktop", surface: "conversation" },
    { platform: "android", formFactor: "pad", surface: "conversation" },
    { platform: "ios", formFactor: "pad" },
  ])("does not load the native palette on a browser or unsupported host (%j)", async (host) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const requested: string[] = [];
      page.on("request", (request) => {
        if (nativeThemeModule.test(request.url())) {
          requested.push(request.url());
        }
      });
      await page.addInitScript((embed) => {
        Object.assign(window, { __OPENCLAW_NATIVE_EMBED__: embed });
      }, host);
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new`);
      await waitForControlUiRoute(page, { routeId: "new-session" });
      expect(requested).toEqual([]);
      expect(await page.locator("#openclaw-custom-theme").count()).toBe(0);
    });
  });

  it("keeps the native palette isolated during unsupported host notification startup", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const requested: string[] = [];
      page.on("request", (request) => {
        if (nativeThemeModule.test(request.url())) {
          requested.push(request.url());
        }
      });
      await page.addInitScript(() => {
        const messages: string[] = [];
        Object.assign(window, {
          notificationMessages: messages,
          __OPENCLAW_NATIVE_EMBED__: {
            platform: "ios",
            formFactor: "phone",
            surface: "conversation",
          },
          __OPENCLAW_NATIVE_NOTIFICATIONS__: { permission: "notDetermined" },
          webkit: {
            messageHandlers: {
              openclawNotifications: {
                postMessage(message: { type: string }) {
                  messages.push(message.type);
                },
              },
            },
          },
        });
      });
      await installMockGateway(page, { awaitInitialRoster: false });
      await page.goto(`${suite.server.baseUrl}new`);
      // The real production lifecycle must reach the working host handler.
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, "notificationMessages")))
        .toContain("status");
      await waitForControlUiRoute(page, { routeId: "new-session" });
      expect(requested).toEqual([]);
      expect(await page.locator("#openclaw-custom-theme").count()).toBe(0);
    });
  });

  it.each(["fetch", "evaluation"])(
    "does not mount when native palette %s fails",
    async (failureKind) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        let requests = 0;
        await page.route(nativeThemeModule, async (route) => {
          requests += 1;
          if (failureKind === "fetch") {
            await route.abort("failed");
          } else {
            await route.fulfill({
              contentType: "text/javascript",
              body: 'throw new Error("native theme evaluation rejected");',
            });
          }
        });
        await page.addInitScript((palette) => {
          Object.assign(window, {
            __OPENCLAW_NATIVE_EMBED__: {
              platform: "ios",
              formFactor: "pad",
              surface: "conversation",
              appearance: palette,
            },
          });
        }, appearance);
        await installMockGateway(page, { awaitInitialRoster: false });
        const failure = page.waitForEvent("pageerror");
        await page.goto(`${suite.server.baseUrl}new`, { waitUntil: "commit" });
        expect((await failure).message).toContain(
          failureKind === "fetch"
            ? "Failed to fetch dynamically imported module"
            : "native theme evaluation rejected",
        );
        expect(requests).toBe(1);
        expect(await page.locator("openclaw-app-shell").count()).toBe(0);
        expect(await page.locator("#openclaw-custom-theme").count()).toBe(0);
      });
    },
  );

  it.each([false, true])(
    "prepares the native palette before the first application theme, with malformed fallback (%s)",
    async (malformed) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), colorScheme: "light" },
        async ({ page }) => {
          const held = await holdModuleResponse(page, nativeThemeModule);
          await page.addInitScript(
            (palette) => {
              Object.assign(window, {
                __OPENCLAW_NATIVE_EMBED__: {
                  platform: "ios",
                  formFactor: "pad",
                  surface: "conversation",
                  appearance: palette,
                },
              });
            },
            malformed ? { ...appearance, dark: {} } : appearance,
          );
          await installMockGateway(page, { awaitInitialRoster: false });
          try {
            await page.goto(`${suite.server.baseUrl}new`, { waitUntil: "commit" });
            await held.request;
            expect(await page.locator("openclaw-app-shell").count()).toBe(0);
            expect(await page.locator("#openclaw-custom-theme").count()).toBe(0);
            held.release();
            await waitForControlUiRoute(page, { routeId: "new-session" });
            expect(held.requests()).toBe(1);
            const presentation = await page.evaluate(() => ({
              theme: document.documentElement.dataset.themeId,
              background: getComputedStyle(document.documentElement)
                .getPropertyValue("--bg")
                .trim(),
              customStyle: document.getElementById("openclaw-custom-theme") !== null,
            }));
            expect(presentation.customStyle).toBe(!malformed);
            if (!malformed) {
              expect(presentation.theme).toBe("custom");
              expect(presentation.background).toBe("#fafafa");
            } else {
              expect(presentation.theme).not.toBe("custom");
            }
          } finally {
            held.release();
          }
        },
      );
    },
  );
});
