import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import {
  takeControlUiElementScreenshot,
  takeControlUiScreenshotFrame,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
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
  const shellHas = (page: Page, name: string, present = true) => {
    const result = expect.poll(() => page.locator(".shell").getAttribute("class"));
    return present ? result.toContain(name) : result.not.toContain(name);
  };
  async function capture(page: Page, file: string, element: Locator, targets: Locator[]) {
    if (captureProof) {
      await writeFile(
        path.join(suite.artifactDir, file),
        await takeControlUiElementScreenshot(page, element, targets),
      );
    }
  }

  async function openPage(options: {
    hasTouch?: boolean;
    height?: number;
    phone?: boolean;
    route?: string;
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
    const response = await page.goto(`${suite.server.baseUrl}${options.route ?? ""}`);
    expect(response?.status()).toBe(200);
    const ready = options.route?.startsWith("settings/") ? ".settings-sidebar" : ".sidebar-rail";
    await page.locator(ready).waitFor({ state: "attached" });
    return page;
  }

  it("keeps only history controls in the Settings titlebar", async () => {
    const page = await openPage({ webChrome: true, route: "settings/general" });

    const toolbar = page.locator(".macos-titlebar-controls");
    await expect.poll(() => toolbar.isVisible()).toBe(true);
    await expect.poll(() => toolbar.getByRole("button").count()).toBe(2);
    for (const name of ["Back", "Forward"]) {
      await expect.poll(() => toolbar.getByRole("button", { name }).isVisible()).toBe(true);
    }
    for (const name of ["Expand sidebar", "Open command palette", "New session"]) {
      await expect.poll(() => toolbar.getByRole("button", { name }).count()).toBe(0);
    }
  });

  it("keeps the document root scroll-locked in the Settings takeover", async () => {
    const page = await openPage({ webChrome: true, route: "settings/general" });
    await page.locator(".settings-sidebar").waitFor({ state: "visible" });

    // Force overflow as in WKWebView, where it can drag the entire Settings UI.
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

  it.each([false, true])("keeps compact chat search reachable (phone: %s)", async (phone) => {
    const page = await openPage(
      phone ? { hasTouch: true, height: 852, phone, width: 393 } : { width: 900 },
    );
    if (phone) {
      await shellHas(page, "shell--mobile-nav");
    }
    await shellHas(page, "shell--merged-chat-chrome");
    await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);

    const header = page.locator(".chat-pane__header").first();
    const drawerButton = header.getByRole("button", { name: "Expand sidebar" });
    await drawerButton.waitFor({ state: "visible" });
    await expect.poll(() => header.locator(".chat-pane__palette-open").count()).toBe(0);
    if (phone) {
      await capture(page, "01-chat-title-bar.png", header, [drawerButton]);
      await drawerButton.tap();
      await shellHas(page, "shell--nav-drawer-open");
      const drawerSearch = page.locator(".shell-nav .sidebar-brand__search");
      await expect.poll(() => drawerSearch.isVisible()).toBe(true);
      await capture(page, "02-sidebar-drawer.png", page.locator(".shell-nav"), [drawerSearch]);
      await drawerSearch.tap();
    } else {
      await header.locator(".chat-header-session-menu__trigger").click();
      await page.getByText("Open command palette", { exact: true }).click();
    }
    const paletteInput = page.locator(".cmd-palette__input");
    await paletteInput.waitFor({ state: "visible" });
    if (phone) {
      await expect.poll(() => paletteInput.evaluate((input) => input.matches(":focus"))).toBe(true);
      await capture(page, "03-command-palette.png", page.locator(".cmd-palette").first(), [
        paletteInput,
      ]);
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
      await shellHas(page, "shell--mobile-nav");

      const dispatchTouch = async (type: string, x: number, y = 180) => {
        await page.locator(".content").evaluate(
          (content, point) => {
            const touch = new Touch({
              identifier: 1,
              target: content,
              clientX: point.x,
              clientY: point.y,
            });
            content.dispatchEvent(
              new TouchEvent(point.type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                touches: point.type === "touchend" ? [] : [touch],
                changedTouches: [touch],
              }),
            );
          },
          { type, x, y },
        );
      };
      // A short drag and a vertical scroll must leave the chat unobscured.
      for (const point of [
        { x: 44, y: 180 },
        { x: 28, y: 240 },
      ]) {
        await dispatchTouch("touchstart", 24);
        await dispatchTouch("touchmove", point.x, point.y);
        expect(await shell.getAttribute("class")).not.toContain("shell--nav-drawer-open");
        expect(
          await page.locator(".shell-nav").evaluate((nav) => getComputedStyle(nav).opacity),
        ).toBe("0");
        await dispatchTouch("touchend", point.x, point.y);
      }
      await dispatchTouch("touchstart", 24);
      await dispatchTouch("touchmove", 210, 184);

      const drawer = page.locator(".shell-nav.nav-drawer");
      if (captureProof && width === 393) {
        const frame = await takeControlUiScreenshotFrame(
          page,
          shell,
          [page.locator(".chat-pane__header").first()],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "held-swipe.png"), frame.png);
      }
      // A deliberate swipe opens while the finger is still down, rather than
      // exposing a clipped, non-interactive slice until touchend.
      await expect.poll(() => shell.getAttribute("class")).toContain("shell--nav-drawer-open");
      await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);

      await dispatchTouch("touchend", 210, 184);

      await shellHas(page, "shell--nav-drawer-open");
      await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
      await expect.poll(() => drawer.evaluate((element) => element.style.transform)).toBe("");
      await expect.poll(() => drawer.locator("openclaw-toast-host").count()).toBe(1);
      const backdrop = page.locator(".shell-nav-backdrop");
      // Fixed/sticky backgrounds would leak a Safari native-chrome tint.
      expect(
        await backdrop.evaluate((element) => {
          const positions: string[] = [];
          for (
            let ancestor: Element | null = element;
            ancestor;
            ancestor = ancestor.parentElement
          ) {
            positions.push(getComputedStyle(ancestor).position);
          }
          return positions.filter((position) => position === "fixed" || position === "sticky");
        }),
      ).toEqual([]);

      // The scrim must cover safe-area padding as well as shell content.
      await page.evaluate(() => {
        const style = document.documentElement.style;
        for (const [edge, value] of Object.entries({ top: 48, bottom: 30, left: 20, right: 20 })) {
          style.setProperty(`--safe-area-${edge}`, `${value}px`);
        }
      });
      for (const canvasHeight of [height, height - 100]) {
        await page.setViewportSize({ width, height: canvasHeight });
        await expect
          .poll(async () => {
            return backdrop.evaluate((element) => {
              const canvas = document.querySelector("openclaw-app")!.getBoundingClientRect();
              const scrim = element.getBoundingClientRect();
              const corners: [number, number][] = [
                [canvas.left + 1, canvas.top + 1],
                [canvas.right - 1, canvas.top + 1],
                [canvas.left + 1, canvas.bottom - 1],
                [canvas.right - 1, canvas.bottom - 1],
              ];
              return {
                bounds: [scrim.x, scrim.y, scrim.width, scrim.height],
                canvas: [canvas.x, canvas.y, canvas.width, canvas.height],
                coversCorners: corners.every(
                  ([x, y]) => document.elementFromPoint(x, y) === element,
                ),
              };
            });
          })
          .toEqual({
            bounds: [0, 0, width, canvasHeight],
            canvas: [0, 0, width, canvasHeight],
            coversCorners: true,
          });
      }
      await backdrop.click({ position: { x: width - 10, y: 100 } });
      await shellHas(page, "shell--nav-drawer-open", false);
      await expect.poll(() => shell.locator(":scope > openclaw-toast-host").count()).toBe(1);
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(20);
      expect(errors).toEqual([]);
    },
  );
});
