import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { afterEach, expect, it } from "vitest";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI native-nav responsive layout E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

let context: BrowserContext | undefined;

suite.define(() => {
  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

  async function openPage(options: {
    hasTouch?: boolean;
    height?: number;
    phone?: boolean;
    webChrome?: boolean;
    width?: number;
  }) {
    context = await suite.browser.newContext({
      hasTouch: options.hasTouch,
      locale: "en-US",
      serviceWorkers: "block",
      ...(options.phone
        ? {
            deviceScaleFactor: 3,
            isMobile: true,
            userAgent:
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
          }
        : {}),
      viewport: { height: options.height ?? 900, width: options.width ?? 1280 },
    });
    const page = await context.newPage();
    if (options.webChrome) {
      await installNativeWebChrome(page);
    }
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
    });
    const response = await page.goto(suite.server.baseUrl);
    expect(response?.status()).toBe(200);
    await page.locator(".sidebar-rail").waitFor({ state: "attached" });
    return page;
  }

  it("keeps only history controls in the Settings titlebar", async () => {
    const page = await openPage({ webChrome: true });
    const response = await page.goto(`${suite.server.baseUrl}settings/general`);
    expect(response?.status()).toBe(200);

    const toolbar = page.locator(".macos-titlebar-controls");
    await expect.poll(() => toolbar.isVisible()).toBe(true);
    await expect.poll(() => toolbar.getByRole("button").count()).toBe(2);
    await expect.poll(() => toolbar.getByRole("button", { name: "Back" }).isVisible()).toBe(true);
    await expect
      .poll(() => toolbar.getByRole("button", { name: "Forward" }).isVisible())
      .toBe(true);
    await expect
      .poll(() => toolbar.getByRole("button", { name: "Expand sidebar" }).count())
      .toBe(0);
    await expect
      .poll(() => toolbar.getByRole("button", { name: "Open command palette" }).count())
      .toBe(0);
    await expect.poll(() => toolbar.getByRole("button", { name: "New session" }).count()).toBe(0);
  });

  it("keeps the document root scroll-locked in the Settings takeover", async () => {
    const page = await openPage({ webChrome: true });
    const response = await page.goto(`${suite.server.baseUrl}settings/general`);
    expect(response?.status()).toBe(200);
    await page.locator(".settings-sidebar").waitFor({ state: "visible" });

    // WKWebView scrolls the document whenever it overflows, dragging the
    // settings sidebar and content along. Force overflow the way stray
    // content would, then confirm the root refuses to move.
    const metrics = await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "3000px";
      document.body.append(spacer);
      window.scrollTo(0, 500);
      document.documentElement.scrollTop = 500;
      document.body.scrollTop = 500;
      return {
        bodyScrollTop: document.body.scrollTop,
        htmlScrollTop: document.documentElement.scrollTop,
        rootScrollY: window.scrollY,
      };
    });
    expect(metrics).toEqual({ bodyScrollTop: 0, htmlScrollTop: 0, rootScrollY: 0 });
  });

  it("keeps drawer and search reachable from the narrow chat title bar", async () => {
    const page = await openPage({ width: 900 });
    const header = page.locator(".chat-pane__header").first();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--merged-chat-chrome");
    await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);
    await expect
      .poll(() => header.getByRole("button", { name: "Expand sidebar" }).isVisible())
      .toBe(true);
    await expect.poll(() => header.locator(".chat-pane__palette-open").count()).toBe(0);
    await header.locator(".chat-header-session-menu__trigger").click();
    await page.getByText("Open command palette", { exact: true }).click();
    await page.locator(".cmd-palette__input").waitFor({ state: "visible" });
  });

  it("opens search from the phone drawer while keeping the chat header compact", async () => {
    const page = await openPage({ hasTouch: true, height: 852, phone: true, width: 393 });
    const shell = page.locator(".shell");
    await expect.poll(() => shell.getAttribute("class")).toContain("shell--mobile-nav");
    await expect.poll(() => shell.getAttribute("class")).toContain("shell--merged-chat-chrome");
    await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);

    const header = page.locator(".chat-pane__header").first();
    const drawerButton = header.getByRole("button", { name: "Expand sidebar" });
    await drawerButton.waitFor({ state: "visible" });
    await expect.poll(() => header.locator(".chat-pane__palette-open").count()).toBe(0);
    if (captureProof) {
      await writeFile(
        path.join(suite.artifactDir, "01-chat-title-bar.png"),
        await takeControlUiElementScreenshot(page, header, [drawerButton]),
      );
    }

    await drawerButton.tap();
    await expect.poll(() => shell.getAttribute("class")).toContain("shell--nav-drawer-open");
    const drawerSearch = page.locator(".shell-nav .sidebar-brand__search");
    await expect.poll(() => drawerSearch.isVisible()).toBe(true);

    if (captureProof) {
      await writeFile(
        path.join(suite.artifactDir, "02-sidebar-drawer.png"),
        await takeControlUiElementScreenshot(page, page.locator(".sidebar-rail").first(), [
          drawerSearch,
        ]),
      );
    }

    await drawerSearch.tap();
    const paletteInput = page.locator(".cmd-palette__input");
    await paletteInput.waitFor({ state: "visible" });
    await expect.poll(() => paletteInput.evaluate((input) => input.matches(":focus"))).toBe(true);
    if (captureProof) {
      await writeFile(
        path.join(suite.artifactDir, "03-command-palette.png"),
        await takeControlUiElementScreenshot(page, page.locator(".cmd-palette").first(), [
          paletteInput,
        ]),
      );
    }
  });

  it.each([
    { width: 852, height: 393, atomicMoves: true },
    { width: 393, height: 852, atomicMoves: false },
  ])(
    "fully opens and closes the mobile drawer by swipe ($width px, atomic moves: $atomicMoves)",
    async ({ width, height, atomicMoves }) => {
      const page = await openPage({ hasTouch: true, height, width });
      if (!atomicMoves) {
        // Safari does not implement atomic DOM moves; drawer completion must not depend on them.
        await page.evaluate(() => {
          Object.defineProperty(Element.prototype, "moveBefore", {
            configurable: true,
            value: undefined,
          });
        });
      }
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shell = page.locator(".shell");
      await expect.poll(() => shell.getAttribute("class")).toContain("shell--mobile-nav");

      await page.locator(".content").evaluate((content) => {
        const touch = (clientX: number, clientY: number) =>
          new Touch({
            identifier: 1,
            target: content,
            clientX,
            clientY,
            pageX: clientX,
            pageY: clientY,
            screenX: clientX,
            screenY: clientY,
          });
        content.dispatchEvent(
          new TouchEvent("touchstart", {
            bubbles: true,
            composed: true,
            touches: [touch(24, 180)],
            changedTouches: [touch(24, 180)],
          }),
        );
        content.dispatchEvent(
          new TouchEvent("touchmove", {
            bubbles: true,
            cancelable: true,
            composed: true,
            touches: [touch(210, 184)],
            changedTouches: [touch(210, 184)],
          }),
        );
        content.dispatchEvent(
          new TouchEvent("touchend", {
            bubbles: true,
            composed: true,
            touches: [],
            changedTouches: [touch(210, 184)],
          }),
        );
      });

      await expect.poll(() => shell.getAttribute("class")).toContain("shell--nav-drawer-open");
      const drawer = page.locator(".shell-nav.nav-drawer");
      await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
      await expect.poll(() => drawer.evaluate((element) => element.style.transform)).toBe("");
      await expect.poll(() => drawer.locator("openclaw-toast-host").count()).toBe(1);
      await page.locator(".shell-nav-backdrop").click({ position: { x: width - 10, y: 100 } });
      await expect.poll(() => shell.getAttribute("class")).not.toContain("shell--nav-drawer-open");
      await expect.poll(() => shell.locator(":scope > openclaw-toast-host").count()).toBe(1);
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
      expect(errors).toEqual([]);
    },
  );
});
