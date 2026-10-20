import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  dockChatSidePanel,
  focusChatSidePanel,
  openChatSidePanelType,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native desktop titlebar E2E" });
const namedButton = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
const attribute = (locator: Locator, name: string) => expect.poll(() => locator.getAttribute(name));
const nativeHistory = (page: Page) =>
  page.evaluate(() => Reflect.get(window, "__OPENCLAW_NATIVE_HISTORY__"));

async function drag(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y);
  await page.mouse.up();
}

function installChat(page: Page, content: string) {
  return installMockGateway(page, {
    featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
    historyMessages: [{ role: "assistant", content }],
  });
}

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

async function keepsLegacyFrame(page: Page, platform: "linux" | "windows" | "macos") {
  const actions = await installWindowChrome(page, platform);
  await page.route("**/legacy-dashboard", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Legacy dashboard</title><main><button>Settings</button></main>",
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
      controls: document.querySelectorAll(".openclaw-window-controls, .openclaw-window-drag-edge")
        .length,
    })),
  ).toEqual({
    chromeEnabled: undefined,
    history: undefined,
    adapter: undefined,
    rootClasses: "",
    controls: 0,
  });
  await namedButton(page, "Settings").click({ trial: true });
}

async function keepsWindowControlsClear(page: Page, platform: "linux" | "windows", width: number) {
  const actions = await installWindowChrome(page, platform);
  await installChat(page, "Titlebar selection regression.");
  await page.goto(suite.server.baseUrl);
  await page.locator(".chat-pane__header").waitFor();
  const toolbar = page.locator(".macos-titlebar-controls");
  await toolbar.waitFor();
  const assertChromeClear = async () => {
    // Closing native popovers retain light-DOM buttons outside the toolbar's hit targets.
    const controls = page.locator(
      ":is(.chat-pane__header, [data-region-header='side'], .sidebar-rail, .sidebar-session-toolbar, .settings-sidebar__header, .content-header, .new-session-page__incognito-rail) button:visible:not([role='menu'] button):not([popover] button)",
    );
    expect(await controls.count()).toBeGreaterThan(0);
    // Wait for sidebar transitions before testing hit targets.
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
  await namedButton(page, "Minimize window").click();
  await namedButton(page, "Close window").click();
  expect(await actions()).toEqual(["ready", "minimize", "close"]);
  expect(await nativeHistory(page)).toBeUndefined();
  await page.evaluate(() => window.dispatchEvent(new Event("openclaw:native-browser-ready")));
  await expect.poll(actions).toEqual(["ready", "minimize", "close", "ready", "state"]);
  expect(await nativeHistory(page)).toEqual({ canGoBack: false, canGoForward: false });
  await assertChromeClear();
  const transcript = page
    .locator(".chat-thread")
    .getByText("Titlebar selection regression.", { exact: true });
  await transcript.waitFor();
  const beforeTextPress = await actions();
  // Scrolled transcript hits can have titlebar coordinates: exercise real bubbling.
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
  await drag(page, bar!.x + 140, 40);
  await expect
    .poll(async () => (await actions()).filter((action) => action === "drag"))
    .toHaveLength(1);
  await page.mouse.dblclick(bar!.x + 140, 40);
  const maximize = page.locator('.openclaw-window-controls [data-action="toggle-maximize"]');
  await attribute(maximize, "aria-label").toBe("Restore window");
  await maximize.click();
  await attribute(maximize, "aria-label").toBe("Maximize window");
  const beforeNavigation = await actions();
  await page.locator(".sidebar-session-toolbar__collapse").click();
  expect(await actions()).toEqual(beforeNavigation);
  await attribute(page.locator(".shell"), "class").toContain("shell--nav-collapsed");
  await assertChromeClear();
  await openChatSidePanelType(page, "Side chat");
  await assertChromeClear();
  // Narrow panes intentionally omit the dock selector.
  if (width > 900) {
    for (const dock of ["left", "bottom", "right"] as const) {
      await dockChatSidePanel(page, dock);
      await assertChromeClear();
    }
  }
  await focusChatSidePanel(page);
  await assertChromeClear();
  await page.locator(".sidebar-rail__create a, .sidebar-rail__create button").click();
  await page.locator(".new-session-page__message").waitFor();
  await assertChromeClear();
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
    await drag(page, bounds!.x + x, bounds!.y + 26);
  }
  await expect
    .poll(async () => (await actions()).filter((action) => action === "drag"))
    .toHaveLength(beforeSettingsDrag + 2);
  await assertChromeClear();
  const beforeModal = (await actions()).length;
  await page.keyboard.press("ControlOrMeta+K");
  await page.locator(".cmd-palette-overlay").waitFor();
  await expect.poll(async () => (await actions()).slice(beforeModal)).toEqual(["native-frame"]);
  const caption = page.locator(".openclaw-window-controls");
  await expect.poll(() => caption.isVisible()).toBe(false);
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await actions()).slice(beforeModal))
    .toEqual(["native-frame", "ready"]);
  await expect.poll(() => caption.isVisible()).toBe(true);
  await namedButton(caption, "Minimize window").click({ trial: true });
}

async function alignsNativeHeaders(
  page: Page,
  host: "web" | "macos" | "tauri-linux" | "tauri-macos",
) {
  const native = host !== "web";
  const macos = host === "macos" || host === "tauri-macos";
  if (host === "macos") {
    await installNativeWebChrome(page);
  }
  if (host.startsWith("tauri-")) {
    await installWindowChrome(page, macos ? "macos" : "linux");
  }
  await installChat(page, "Selectable transcript content.");
  await page.goto(`${suite.server.baseUrl}chat`);
  const row = page.locator(".sidebar-session-toolbar");
  const collapse = row.getByRole("button", { name: "Collapse sidebar" });
  await collapse.waitFor();
  expect(await collapse.getAttribute("aria-expanded")).toBe("true");
  expect(await row.locator("a").count()).toBe(0);
  expect(await row.getByRole("button", { name: /New (session|conversation)/ }).count()).toBe(0);
  await page.mouse.move(600, 600);
  const restingBackgrounds = await row
    .locator("button.sidebar-session-toolbar__button")
    .evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor));
  expect(restingBackgrounds).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
  const geometry = await row.evaluate((element) => {
    const box = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect().toJSON();
    return {
      row: element.getBoundingClientRect().toJSON(),
      title: element.firstElementChild!.getBoundingClientRect().toJSON(),
      agent: box(".sidebar-agent-card__main"),
      panelPadding: getComputedStyle(document.querySelector(".sidebar-shell")!).paddingTop,
    };
  });
  if (native) {
    expect(geometry).toMatchObject({ row: { y: 0, height: 52 }, panelPadding: "0px" });
    expect(geometry.title.y + geometry.title.height / 2).toBeCloseTo(26, 1);
    expect(geometry.title.x).toBe(macos ? 92 : 68);
    expect(geometry.agent.y + geometry.agent.height / 2).toBe(macos ? 70 : 26);
    const history = page.locator(".macos-titlebar-controls");
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
    expect(panelGeometry).toMatchObject({ y: geometry.row.y, height: geometry.row.height });
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
      .locator(native ? ".shell-chrome-controls__nav-toggle" : `[data-navigation-view="${panel}"]`)
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
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label"))),
  ).toEqual(native ? ["Expand sidebar"] : []);
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
}

suite.define(() => {
  it.each(["linux", "windows", "macos"] as const)(
    "keeps the native %s frame when a dashboard does not advertise shared chrome",
    (platform) =>
      suite.withPage({ viewport: { width: 1280, height: 900 } }, ({ page }) =>
        keepsLegacyFrame(page, platform),
      ),
  );
  it.each([
    { platform: "linux" as const, width: 1280 },
    { platform: "windows" as const, width: 720 },
  ])("keeps $platform window controls clear at $width pixels", ({ platform, width }) =>
    suite.withPage(
      { viewport: { width, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      ({ page }) => keepsWindowControlsClear(page, platform, width),
    ),
  );
  it.each(["web", "macos", "tauri-linux", "tauri-macos"] as const)(
    "aligns the %s rail, panel header, and content history row",
    (host) =>
      suite.withPage({ viewport: { width: 1240, height: 860 } }, ({ page }) =>
        alignsNativeHeaders(page, host),
      ),
  );
});
