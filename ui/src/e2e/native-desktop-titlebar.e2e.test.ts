import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  dockChatSidePanel,
  focusChatSidePanel,
  openChatSidePanelType,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native desktop titlebar E2E" });

async function installWindowChrome(page: Page, platform: "linux" | "windows" | "macos") {
  const chromeScript = readFileSync(
    new URL("../../../apps/linux/ui/window-chrome.js", import.meta.url),
    "utf8",
  );
  const chromeCss = readFileSync(
    new URL("../../../apps/linux/ui/window-chrome.css", import.meta.url),
    "utf8",
  );
  await page.addInitScript(() => {
    const actions: string[] = [];
    let maximized = false;
    Object.assign(window, {
      openclawWindowActions: actions,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, params: { action: string }) => {
          if (command === "window_chrome_drag") {
            actions.push("drag");
            return null;
          }
          actions.push(params.action);
          const state = { maximized, fullscreen: false, focused: true };
          if (params.action === "toggle-maximize") {
            maximized = !maximized;
            queueMicrotask(() =>
              window.dispatchEvent(
                new CustomEvent("openclaw:window-state", { detail: { ...state, maximized } }),
              ),
            );
          }
          return {
            ...state,
            ...(params.action === "state"
              ? { history: { canGoBack: false, canGoForward: false } }
              : {}),
          };
        },
      },
    });
  });
  await page.addInitScript({
    content: `(${chromeScript})(${JSON.stringify({ platform, origin: new URL(suite.server.baseUrl).origin, css: chromeCss, waitForDashboard: true })})`,
  });
  return () => page.evaluate(() => Reflect.get(window, "openclawWindowActions") as string[]);
}

suite.define(() => {
  it.each(["linux", "windows", "macos"] as const)(
    "keeps the native %s frame when a dashboard does not advertise shared chrome",
    async (platform) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const actions = await installWindowChrome(page, platform);
        await page.route("**/legacy-dashboard", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><html><head><title>Legacy dashboard</title></head><body><main><h1>Dashboard</h1><button>Settings</button></main></body></html>",
          }),
        );
        await page.goto(`${suite.server.baseUrl}legacy-dashboard`);
        await expect.poll(actions).toEqual(["native-frame"]);
        await page.evaluate(() => {
          window.dispatchEvent(
            new CustomEvent("openclaw:window-state", {
              detail: { focused: false, maximized: true, fullscreen: true },
            }),
          );
          window.dispatchEvent(new Event("openclaw:window-history-changed"));
          window.dispatchEvent(new Event("openclaw:native-browser-ready"));
        });
        expect(await actions()).toEqual(["native-frame"]);
        expect(
          await page.evaluate(() => ({
            chromeEnabled: Reflect.get(window, "__OPENCLAW_NATIVE_WEB_CHROME__"),
            history: Reflect.get(window, "__OPENCLAW_NATIVE_HISTORY__"),
            adapter: Reflect.get(window, "__OPENCLAW_WINDOW_HANDLERS__"),
            rootClasses: document.documentElement.className,
            controls: document.querySelectorAll(
              ".openclaw-window-controls, .openclaw-window-drag-edge",
            ).length,
          })),
        ).toEqual({
          chromeEnabled: undefined,
          history: undefined,
          adapter: undefined,
          rootClasses: "",
          controls: 0,
        });
        await page.getByRole("button", { name: "Settings", exact: true }).click({ trial: true });
      });
    },
  );

  it.each([
    { platform: "linux" as const, width: 1280 },
    { platform: "windows" as const, width: 720 },
  ])("keeps $platform window controls clear at $width pixels", async ({ platform, width }) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const proofParent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
        const proofDir = proofParent
          ? createControlUiE2eArtifactDir("native-desktop-titlebar", proofParent)
          : undefined;
        const actions = await installWindowChrome(page, platform);
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
        });
        await page.goto(suite.server.baseUrl);
        await page.locator(".chat-pane__header").waitFor();
        const toolbar = page.locator(".macos-titlebar-controls");
        await toolbar.waitFor();
        const assertChromeClear = async () => {
          const controls = page.locator(
            ".chat-pane__header button:visible, [data-region-header='side'] button:visible, .sidebar-brand button:visible, .settings-sidebar__header button:visible, .content-header button:visible, .new-session-page__incognito-rail button:visible",
          );
          expect(await controls.count()).toBeGreaterThan(0);
          // Sidebar transitions settle before the screenshot and hit-target proof.
          await expect
            .poll(() =>
              controls.evaluateAll((buttons, viewportWidth) => {
                const titlebar = document
                  .querySelector(".macos-titlebar-controls")!
                  .getBoundingClientRect();
                return buttons.flatMap((button) => {
                  const box = button.getBoundingClientRect();
                  return box.y < 52 && (box.right > viewportWidth - 138 || box.x < titlebar.right)
                    ? [button.getAttribute("aria-label") ?? button.textContent?.trim()]
                    : [];
                });
              }, width),
            )
            .toEqual([]);
          for (const control of await controls.all()) {
            if (await control.isEnabled()) {
              await control.click({ trial: true });
            }
          }
        };
        const capture = async (state: string) => {
          if (proofDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, `${platform}-${width}-${state}.png`),
            });
          }
        };
        await page.getByRole("button", { name: "Minimize window", exact: true }).click();
        await page.getByRole("button", { name: "Close window", exact: true }).click();
        expect(await actions()).toEqual(["ready", "minimize", "close"]);
        expect(
          await page.evaluate(() => Reflect.get(window, "__OPENCLAW_NATIVE_HISTORY__")),
        ).toBeUndefined();
        await page.evaluate(() => window.dispatchEvent(new Event("openclaw:native-browser-ready")));
        await expect.poll(actions).toEqual(["ready", "minimize", "close", "ready", "state"]);
        expect(
          await page.evaluate(() => Reflect.get(window, "__OPENCLAW_NATIVE_HISTORY__")),
        ).toEqual({ canGoBack: false, canGoForward: false });
        await assertChromeClear();
        await capture("chat-expanded");
        const bar = await toolbar.boundingBox();
        expect(bar).not.toBeNull();
        await page.mouse.move(bar!.x + 140, 40);
        await page.mouse.down();
        await page.mouse.move(bar!.x + 160, 40);
        await page.mouse.up();
        await expect
          .poll(async () => (await actions()).filter((action) => action === "drag"))
          .toHaveLength(1);
        await toolbar.dblclick({ position: { x: 140, y: 40 } });
        const maximize = page.locator('.openclaw-window-controls [data-action="toggle-maximize"]');
        await expect.poll(() => maximize.getAttribute("aria-label")).toBe("Restore window");
        await maximize.click();
        await expect.poll(() => maximize.getAttribute("aria-label")).toBe("Maximize window");
        const beforeNavigation = await actions();
        await toolbar.getByRole("button", { name: "Collapse sidebar" }).click();
        expect(await actions()).toEqual(beforeNavigation);
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--nav-collapsed");
        await assertChromeClear();
        await capture("chat-collapsed");
        await openChatSidePanelType(page, "Side chat");
        await assertChromeClear();
        await capture("chat-side-panel");
        // Narrow panes intentionally omit the dock selector.
        if (width > 900) {
          for (const dock of ["left", "bottom", "right"] as const) {
            await dockChatSidePanel(page, dock);
            await assertChromeClear();
          }
        }
        await focusChatSidePanel(page);
        await assertChromeClear();
        await capture("chat-focused-panel");
        await toolbar.getByRole("button", { name: "New session" }).click();
        await page.locator(".new-session-page__message").waitFor();
        await assertChromeClear();
        await capture("new-session");
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("openclaw:native-navigate", {
              detail: { path: "/settings/appearance" },
            }),
          ),
        );
        await page.locator(".settings-sidebar__back").waitFor();
        await assertChromeClear();
        const beforeSettingsDrag = (await actions()).filter((action) => action === "drag").length;
        for (const [selector, x] of [
          [".content", 50],
          [".settings-sidebar__header", 220],
        ] as const) {
          const bounds = await page.locator(selector).boundingBox();
          expect(bounds).not.toBeNull();
          await page.mouse.move(bounds!.x + x, bounds!.y + 26);
          await page.mouse.down();
          await page.mouse.move(bounds!.x + x + 20, bounds!.y + 26);
          await page.mouse.up();
        }
        await expect
          .poll(async () => (await actions()).filter((action) => action === "drag"))
          .toHaveLength(beforeSettingsDrag + 2);
        await capture("settings");
        const beforeModal = (await actions()).length;
        await page.keyboard.press("ControlOrMeta+K");
        await page.locator(".cmd-palette-overlay").waitFor();
        await expect
          .poll(async () => (await actions()).slice(beforeModal))
          .toEqual(["native-frame"]);
        const caption = page.locator(".openclaw-window-controls");
        await expect.poll(() => caption.isVisible()).toBe(false);
        await page.keyboard.press("Escape");
        await expect
          .poll(async () => (await actions()).slice(beforeModal))
          .toEqual(["native-frame", "ready"]);
        await expect.poll(() => caption.isVisible()).toBe(true);
        await caption
          .getByRole("button", { name: "Minimize window", exact: true })
          .click({ trial: true });
      },
    );
  });
});
