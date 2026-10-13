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
import { installNativeWebChrome } from "./native-nav.test-support.ts";

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
          historyMessages: [{ role: "assistant", content: "Titlebar selection regression." }],
        });
        await page.goto(suite.server.baseUrl);
        await page.locator(".chat-pane__header").waitFor();
        const toolbar = page.locator(".macos-titlebar-controls");
        await toolbar.waitFor();
        const assertChromeClear = async () => {
          const controls = page.locator(
            ".chat-pane__header button:visible, [data-region-header='side'] button:visible, .sidebar-rail button:visible, .sidebar-session-toolbar button:visible, .settings-sidebar__header button:visible, .content-header button:visible, .new-session-page__incognito-rail button:visible",
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
                  return box.y < 52 &&
                    (box.right > viewportWidth - 138 ||
                      (box.x < titlebar.right && box.right > titlebar.left))
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
        const transcript = page
          .locator(".chat-thread")
          .getByText("Titlebar selection regression.", { exact: true });
        await transcript.waitFor();
        const beforeTextPress = await actions();
        // A transcript hit can carry titlebar-band coordinates after scrolling.
        // Route that hit through the real bubbling path, not the drag helper.
        expect(
          await transcript.evaluate((element) =>
            element.dispatchEvent(
              new MouseEvent("mousedown", {
                bubbles: true,
                composed: true,
                cancelable: true,
                button: 0,
                clientY: 26,
              }),
            ),
          ),
        ).toBe(true);
        expect(await actions()).toEqual(beforeTextPress);
        const bar = await toolbar.boundingBox();
        expect(bar).not.toBeNull();
        await page.mouse.move(bar!.x + 140, 40);
        await page.mouse.down();
        await page.mouse.move(bar!.x + 160, 40);
        await page.mouse.up();
        await expect
          .poll(async () => (await actions()).filter((action) => action === "drag"))
          .toHaveLength(1);
        await page.mouse.dblclick(bar!.x + 140, 40);
        const maximize = page.locator('.openclaw-window-controls [data-action="toggle-maximize"]');
        await expect.poll(() => maximize.getAttribute("aria-label")).toBe("Restore window");
        await maximize.click();
        await expect.poll(() => maximize.getAttribute("aria-label")).toBe("Maximize window");
        const beforeNavigation = await actions();
        await page.locator(".sidebar-session-toolbar__collapse").click();
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
        await page.locator(".sidebar-rail__create a, .sidebar-rail__create button").click();
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

  it.each(["web", "macos", "tauri-linux", "tauri-macos"] as const)(
    "aligns the %s rail, panel header, and content history row",
    async (host) => {
      await suite.withPage({ viewport: { width: 1240, height: 860 } }, async ({ page }) => {
        const native = host !== "web";
        const macos = host === "macos" || host === "tauri-macos";
        if (host === "macos") {
          await installNativeWebChrome(page);
        }
        if (host.startsWith("tauri-")) {
          await installWindowChrome(page, macos ? "macos" : "linux");
        }
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
          historyMessages: [{ role: "assistant", content: "Selectable transcript content." }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const row = page.locator(".sidebar-session-toolbar");
        const collapse = row.getByRole("button", { name: "Collapse sidebar" });
        await collapse.waitFor();
        expect(await collapse.getAttribute("aria-expanded")).toBe("true");
        expect(await row.locator("a").count()).toBe(0);
        expect(await row.getByRole("button", { name: /New (session|conversation)/ }).count()).toBe(
          0,
        );
        await page.mouse.move(600, 600);
        const restingBackgrounds = await row
          .locator("button.sidebar-session-toolbar__button")
          .evaluateAll((buttons) =>
            buttons.map((button) => getComputedStyle(button).backgroundColor),
          );
        expect(restingBackgrounds).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
        expect(await page.locator(".sidebar-brand__search").isVisible()).toBe(true);
        const geometry = await row.evaluate((element) => {
          const box = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect().toJSON();
          return {
            row: element.getBoundingClientRect().toJSON(),
            title: element.firstElementChild!.getBoundingClientRect().toJSON(),
            rail: box(".sidebar-rail"),
            agent: box(".sidebar-agent-card__main"),
            panelPadding: getComputedStyle(document.querySelector(".sidebar-shell")!).paddingTop,
          };
        });
        expect(geometry.rail.width).toBe(52);
        if (native) {
          expect(geometry.row.y).toBe(0);
          expect(geometry.row.height).toBe(52);
          expect(geometry.panelPadding).toBe("0px");
          expect(geometry.title.y + geometry.title.height / 2).toBeCloseTo(26, 1);
          expect(geometry.title.x).toBe(macos ? 92 : 68);
          expect(geometry.agent.y + geometry.agent.height / 2).toBe(macos ? 70 : 26);
          const history = page.locator(".macos-titlebar-controls");
          expect(await history.getByRole("button").allTextContents()).toHaveLength(2);
          expect(await history.getByRole("button", { name: "Open command palette" }).count()).toBe(
            0,
          );
          const [bar, content, title] = await Promise.all([
            history.boundingBox(),
            page.locator(".content").boundingBox(),
            page.locator(".chat-pane__crumbs").first().boundingBox(),
          ]);
          expect(bar!.x).toBe(content!.x + 12);
          expect(title!.x).toBeGreaterThanOrEqual(bar!.x + bar!.width + 8);
        }
        for (const panel of ["pages", "online"] as const) {
          await page.locator(`[data-navigation-view="${panel}"]`).click();
          const header = page.locator(".sidebar-panel-header");
          const toggle = header.getByRole("button", { name: "Collapse sidebar" });
          await toggle.waitFor();
          const panelGeometry = await header.evaluate((element) => {
            const title = element.firstElementChild!.getBoundingClientRect();
            const collapseBounds = element
              .querySelector(".sidebar-session-toolbar__collapse")!
              .getBoundingClientRect();
            const headerBounds = element.getBoundingClientRect();
            return {
              x: title.x,
              y: headerBounds.y,
              height: headerBounds.height,
              center: title.y + title.height / 2,
              collapseCenter: collapseBounds.y + collapseBounds.height / 2,
              collapseRight: collapseBounds.right,
              right: headerBounds.right,
            };
          });
          expect(panelGeometry.y).toBe(geometry.row.y);
          expect(panelGeometry.height).toBe(geometry.row.height);
          expect(panelGeometry.center).toBeCloseTo(geometry.row.y + geometry.row.height / 2, 1);
          expect(panelGeometry.collapseCenter).toBeCloseTo(panelGeometry.center, 1);
          expect(panelGeometry.collapseRight).toBe(panelGeometry.right - 8);
          // Empty header space must stay non-interactive so it can drag the window.
          const dragGap = await header.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const controls = [...element.querySelectorAll("button")]
              .map((button) => button.getBoundingClientRect())
              .toSorted((a, b) => a.left - b.left);
            let start = bounds.left;
            let widest = { left: start, width: 0 };
            for (const control of [...controls, { left: bounds.right, right: bounds.right }]) {
              if (control.left - start > widest.width) {
                widest = { left: start, width: control.left - start };
              }
              start = Math.max(start, control.right);
            }
            const hit = document.elementFromPoint(
              widest.left + widest.width / 2,
              bounds.top + bounds.height / 2,
            );
            return { width: widest.width, button: Boolean(hit?.closest("button")) };
          });
          expect(dragGap.width).toBeGreaterThanOrEqual(24);
          expect(dragGap.button).toBe(false);
          if (native) {
            expect(panelGeometry.x).toBe(macos ? 92 : 68);
          }
          await toggle.click();
          await page
            .locator(
              native ? ".shell-chrome-controls__nav-toggle" : `[data-navigation-view="${panel}"]`,
            )
            .click();
        }
        await page.locator('[data-navigation-view="sessions"]').click();
        await collapse.click();
        const cluster = page.locator(".shell-chrome-controls");
        await expect.poll(() => cluster.isVisible()).toBe(native);
        expect(await page.locator('[data-navigation-view][aria-pressed="true"]').count()).toBe(0);
        expect(
          await cluster
            .locator("button, a")
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("aria-label")),
            ),
        ).toEqual(native ? ["Expand sidebar"] : []);
        expect(await page.locator(".sidebar-brand__search").isVisible()).toBe(true);
        if (native) {
          expect(
            await cluster.locator("button").evaluate((button) => {
              const style = getComputedStyle(button);
              return {
                border: style.borderTopWidth,
                background: style.backgroundColor,
                shadow: style.boxShadow,
              };
            }),
          ).toEqual({ border: "0px", background: "rgba(0, 0, 0, 0)", shadow: "none" });
          expect((await cluster.boundingBox())!.x).toBe(macos ? 92 : 64);
          await expect
            .poll(async () => {
              const [controls, history, title] = await Promise.all([
                cluster.boundingBox(),
                page.locator(".macos-titlebar-controls").boundingBox(),
                page.locator(".chat-pane__crumbs").first().boundingBox(),
              ]);
              return Boolean(
                controls &&
                history &&
                title &&
                history.x >= controls.x + controls.width + 8 &&
                title.x >= history.x + history.width + 8,
              );
            })
            .toBe(true);
        }
        if (native) {
          await cluster.getByRole("button", { name: "Expand sidebar" }).click();
        } else {
          await page.locator('[data-navigation-view="sessions"]').click();
        }
        await collapse.waitFor();
      });
    },
  );
});
