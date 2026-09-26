import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI theme continuity during startup" });
const profileId = "theme-reader";
const secondSessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const variants = [
  { system: "light", mode: "dark", saved: true },
  { system: "dark", mode: "light", saved: true },
  { system: "light", mode: "system", saved: true },
  { system: "dark", mode: "system", saved: true },
  { system: "light", mode: "system", saved: false },
  { system: "dark", mode: "system", saved: false },
] as const;

type ThemeFrame = {
  time: number;
  theme: string | undefined;
  mode: string | undefined;
  html: string;
  body: string;
};

declare global {
  interface Window {
    themeBootFrames: ThemeFrame[];
    themeSiblingStorageObserved: boolean;
  }
}

// Observe the real document and retain transient frames that a settled DOM assertion misses.
const themeFrameObserver = `
window.themeBootFrames = [];
function sampleThemeFrame() {
  const root = document.documentElement;
  if (root && document.body) {
    const html = getComputedStyle(root);
    window.themeBootFrames.push({
      time: performance.now(), theme: root.dataset.theme,
      mode: root.dataset.themeMode, html: html.backgroundColor,
      body: getComputedStyle(document.body).backgroundColor
    });
  }
  requestAnimationFrame(sampleThemeFrame);
}
requestAnimationFrame(sampleThemeFrame);
`;

async function settleThemeFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function assertThemeFrames(
  page: Page,
  expected: { theme: string; mode: string },
): Promise<void> {
  await settleThemeFrames(page);
  const { frames, stable, surfaces } = await page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    // The canvas owner uses --bg and, for narrow chat, --bg-content.
    // Let the browser serialize token colors like computed backgrounds.
    const sample = document.createElement("span");
    sample.style.display = "none";
    document.body.append(sample);
    const surfaceColors = ["--bg", "--bg-content"]
      .map((token) => style.getPropertyValue(token).trim())
      .filter(Boolean)
      .map((color) => {
        sample.style.backgroundColor = color;
        return getComputedStyle(sample).backgroundColor;
      });
    sample.remove();
    return {
      frames: window.themeBootFrames,
      stable: { theme: root.dataset.theme, mode: root.dataset.themeMode },
      surfaces: surfaceColors,
    };
  });
  expect(stable).toEqual(expected);
  expect(surfaces.length).toBeGreaterThan(0);
  expect(frames.length).toBeGreaterThan(0);
  expect(
    frames.filter(
      (frame) =>
        frame.theme !== expected.theme ||
        frame.mode !== expected.mode ||
        !surfaces.includes(frame.html) ||
        !surfaces.includes(frame.body),
    ),
    `Every painted frame must use the resolved palette: ${JSON.stringify({ stable, surfaces })}`,
  ).toEqual([]);
}

suite.define(() => {
  for (const width of [1440, 390]) {
    it.each(variants)(
      `keeps every painted frame at ${width}px for system=$system mode=$mode saved=$saved`,
      async ({ system, mode, saved }) => {
        let releaseAppScripts = () => {};
        await suite.withPage(
          {
            colorScheme: system,
            deviceScaleFactor: 2,
            locale: "en-US",
            serviceWorkers: "block",
            viewport: { width, height: 900 },
          },
          async ({ page }) => {
            const theme = saved ? "rose" : "claw";
            const resolvedMode = mode === "system" ? system : mode;
            const resolvedTheme = saved
              ? resolvedMode === "light"
                ? "rose-light"
                : "rose"
              : resolvedMode;
            const config = saved
              ? { ui: { prefs: { theme: "absolutely", themeMode: system } } }
              : {};
            const profileResponse = {
              status: "ok",
              entries: saved ? { "ui.theme": theme, "ui.themeMode": mode } : {},
            };
            const gateway = await installMockGateway(page, {
              presenceUsers: saved ? [{ id: profileId, name: "Theme Reader", self: true }] : [],
              sessions: [
                { key: "agent:main:main", kind: "direct", label: "Home", updatedAt: 2 },
                {
                  key: secondSessionKey,
                  kind: "direct",
                  label: "Second conversation",
                  updatedAt: 1,
                },
              ],
              deferredMethods: saved ? ["users.prefs.get"] : [],
              historyMessages: [{ role: "assistant", content: "Theme continuity is ready." }],
              methodResponses: {
                "config.get": { config, raw: JSON.stringify(config), hash: "theme-boot" },
                "users.prefs.get": profileResponse,
              },
            });
            await page.addInitScript(
              (seed) => {
                if (!seed.saved || sessionStorage.getItem("theme-boot-seeded")) {
                  return;
                }
                sessionStorage.setItem("theme-boot-seeded", "1");
                localStorage.setItem(
                  `openclaw.control.settings.v1:${seed.gatewayUrl}`,
                  JSON.stringify({
                    gatewayUrl: seed.gatewayUrl,
                    theme: seed.theme,
                    themeMode: seed.mode,
                  }),
                );
                localStorage.setItem(
                  `openclaw.control.serverPrefs.v1:${seed.gatewayUrl}:profile:${seed.profileId}`,
                  JSON.stringify({ theme: seed.theme, themeMode: seed.mode }),
                );
              },
              {
                gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
                theme,
                mode,
                saved,
                profileId,
              },
            );
            await page.addInitScript({ content: themeFrameObserver });
            const expectedAppearance = { theme: resolvedTheme, mode: resolvedMode };
            let appScriptsReady = Promise.resolve();
            const appAssets = new URL("assets/", suite.server.baseUrl);
            await page.route(
              (url) =>
                url.origin === appAssets.origin &&
                url.pathname.startsWith(appAssets.pathname) &&
                url.pathname.endsWith(".js"),
              async (route) => {
                if (route.request().resourceType() === "script") {
                  await appScriptsReady;
                }
                await route.fallback();
              },
            );
            for (const reload of [false, true]) {
              appScriptsReady = new Promise<void>((resolve) => {
                releaseAppScripts = resolve;
              });
              if (reload) {
                await page.reload({ waitUntil: "commit" });
              } else {
                await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "commit" });
              }
              // Make the pre-module paint observable even on fast runners. A
              // final DOM assertion misses a wrong canvas repaired by app boot.
              await page.waitForFunction(() => window.themeBootFrames.length >= 2);
              releaseAppScripts();
              if (saved) {
                await gateway.waitForRequest("users.prefs.get");
                await page.locator(".agent-chat__composer-combobox textarea").waitFor();
                await settleThemeFrames(page);
                await gateway.resolveDeferred("users.prefs.get", profileResponse);
              }
              await page.getByText("Theme continuity is ready.", { exact: true }).waitFor();
              await assertThemeFrames(page, expectedAppearance);
            }
            if (width !== 1440 || !saved || mode === "system") {
              return;
            }
            await gateway.setOnline(false);
            await page.locator(".agent-chat__input--offline").waitFor();
            await assertThemeFrames(page, expectedAppearance);
            await gateway.setOnline(true);
            await waitForControlUiGatewayReady(page);
            await assertThemeFrames(page, expectedAppearance);
            await page.evaluate((url) => {
              history.pushState(null, "", url);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }, `${suite.server.baseUrl}settings/appearance`);
            await waitForControlUiRoute(page, {
              pathname: "/settings/appearance",
              routeId: "appearance",
            });
            await assertThemeFrames(page, expectedAppearance);
            await page.goBack();
            await page.locator(".agent-chat__composer-combobox textarea").waitFor();
            await assertThemeFrames(page, expectedAppearance);
            const newThread = page.locator("openclaw-app-sidebar .sidebar-brand__new-thread");
            await page
              .locator(
                `.sidebar-recent-session[data-session-key="${secondSessionKey}"] a.sidebar-recent-session__link`,
              )
              .click();
            await gateway.waitForRequest("chat.startup", {
              match: { sessionKey: secondSessionKey },
            });
            await assertThemeFrames(page, expectedAppearance);
            await newThread.click();
            await page.locator(".new-session-page__message").waitFor();
            await assertThemeFrames(page, expectedAppearance);
          },
          async () => releaseAppScripts(),
        );
      },
    );
  }

  it("keeps a ready tab's theme while another tab's profile is pending", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        deviceScaleFactor: 2,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      },
      async ({ context, page }) => {
        const profileResponse = {
          status: "ok",
          entries: { "ui.theme": "rose", "ui.themeMode": "dark" },
        };
        const scenario = {
          presenceUsers: [{ id: profileId, name: "Theme Reader", self: true }],
          historyMessages: [{ role: "assistant", content: "Theme continuity is ready." }],
        };
        const config = {
          ui: { prefs: { theme: "claw", themeMode: "light", chatShowThinking: true } },
        };
        await installMockGateway(page, {
          ...scenario,
          methodResponses: {
            "config.get": { config, raw: JSON.stringify(config), hash: "ready-tab" },
            "users.prefs.get": profileResponse,
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Theme continuity is ready.", { exact: true }).waitFor();
        // With no seeded mirror, Rosé proves this tab has applied the resolved profile.
        await page.waitForFunction(
          () =>
            document.documentElement.dataset.theme === "rose" &&
            document.documentElement.dataset.themeMode === "dark",
        );
        await page.evaluate(themeFrameObserver);
        await page.evaluate(
          (settingsKey) => {
            window.themeSiblingStorageObserved = false;
            window.addEventListener("storage", (event) => {
              if (event.key === settingsKey && event.newValue) {
                const settings = JSON.parse(event.newValue);
                if (settings.chatShowThinking === false) {
                  window.themeSiblingStorageObserved = true;
                }
              }
            });
          },
          `openclaw.control.settings.v1:${controlUiBundledGatewayUrl(suite.server.baseUrl)}`,
        );

        const pendingPage = await context.newPage();
        const nextConfig = {
          ui: { prefs: { ...config.ui.prefs, chatShowThinking: false } },
        };
        const pendingGateway = await installMockGateway(pendingPage, {
          ...scenario,
          heldMethods: ["users.prefs.get"],
          methodResponses: {
            "config.get": {
              config: nextConfig,
              raw: JSON.stringify(nextConfig),
              hash: "pending-tab",
            },
            "users.prefs.get": profileResponse,
          },
        });
        // Keep the observed tab foreground so background rAF throttling cannot hide a flash.
        await page.bringToFront();
        await pendingPage.goto(`${suite.server.baseUrl}chat`, { waitUntil: "commit" });
        await pendingGateway.waitForRequest("users.prefs.get");
        // This native event must come from the sibling's nonappearance reconciliation.
        await page.waitForFunction(() => window.themeSiblingStorageObserved, undefined, {
          polling: 25,
        });
        await assertThemeFrames(page, { theme: "rose", mode: "dark" });

        await pendingGateway.resolveDeferred("users.prefs.get", profileResponse);
        await pendingPage.bringToFront();
        await pendingPage.getByText("Theme continuity is ready.", { exact: true }).waitFor();
        await page.bringToFront();
        await assertThemeFrames(page, { theme: "rose", mode: "dark" });
      },
    );
  });
});
