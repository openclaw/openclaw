import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  discoveryCategories,
  discoveryResult,
} from "../test-helpers/plugins-e2e-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI page toolbar row E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const proofDirParent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
let proofDir: string | undefined;
let context: BrowserContext | undefined;
beforeEach(() => {
  proofDir = proofDirParent
    ? createControlUiE2eArtifactDir("page-toolbar-row", proofDirParent)
    : undefined;
});

type Box = { x: number; y: number; width: number; height: number };
const center = (box: Box, axis: "x" | "y") =>
  box[axis] + box[axis === "x" ? "width" : "height"] / 2;

suite.define(() => {
  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  async function openPage(
    route: string,
    install?: (page: Page) => Promise<void>,
    ready = ".content .content-header .page-title",
    gatewayOptions?: Parameters<typeof installMockGateway>[1],
    direction?: "ltr" | "rtl",
  ) {
    context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await install?.(page);
    await installMockGateway(page, gatewayOptions);
    await page.goto(`${suite.server.baseUrl}${route}`);
    await page.locator(ready).first().waitFor({ state: "attached" });
    if (direction) {
      await page.evaluate((dir) => {
        document.documentElement.dir = dir;
      }, direction);
    }
    const native = install === installNativeWebChrome;
    const toggle = native
      ? ".sidebar-session-toolbar__collapse"
      : '[data-navigation-view][aria-pressed="true"]';
    await page.locator(toggle).click();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-collapsed");
    const box = await page
      .locator(native ? ".macos-titlebar-controls" : ".shell-chrome-controls")
      .boundingBox();
    expect(box).not.toBeNull();
    return { page, toolbar: box! };
  }

  async function expectAligned(target: Locator, reference: Locator | number, axis: "x" | "y") {
    await expect
      .poll(async () => {
        const [box, outer] = await Promise.all([
          target.boundingBox(),
          typeof reference === "number" ? reference : reference.boundingBox(),
        ]);
        const coordinate = typeof outer === "number" ? outer : outer && center(outer, axis);
        return box && coordinate !== null ? Math.abs(center(box, axis) - coordinate) : Infinity;
      })
      .toBeLessThanOrEqual(axis === "x" ? 1 : 0.5);
  }
  async function capture(page: Page, file: string) {
    if (proofDir) {
      await page.screenshot({ animations: "disabled", path: path.join(proofDir, file) });
    }
  }
  async function expectActions(header: Locator, y: number, right: number) {
    const buttons = header.locator(".page-header-actions .btn");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index++) {
      await expectAligned(buttons.nth(index), y, "y");
      expect((await buttons.nth(index).boundingBox())!.x).toBeGreaterThan(right);
    }
  }

  it.each([true, false])("centers page titles and clears controls (native: %s)", async (native) => {
    const { page, toolbar } = await openPage(
      "agents",
      native ? installNativeWebChrome : undefined,
      undefined,
      undefined,
      native ? undefined : "rtl",
    );
    const header = page.locator(".content .content-header").first();
    const title = header.locator(".page-title");
    const y = native ? center(toolbar, "y") : 24;
    await expectAligned(title, y, "y");
    await expectAligned(title, header, "x");
    const titleBox = (await title.boundingBox())!;
    let right = titleBox.x + titleBox.width;
    if (native) {
      expect(toolbar.y + toolbar.height).toBe(52);
      expect(titleBox.x).toBeGreaterThan(toolbar.x + toolbar.width);
      expect((await header.locator(".page-subtitle").boundingBox())!.y).toBeGreaterThanOrEqual(52);
      await capture(page, "native-web-collapsed-page-header.png");
    } else {
      const edges = await page
        .locator(".shell-chrome-controls button:visible")
        .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().right));
      right = Math.max(right, ...edges);
    }
    await expectActions(header, y, right);
  });

  it("puts hub tabs in the row instead of a redundant title", async () => {
    const { page, toolbar } = await openPage(
      "sessions",
      installNativeWebChrome,
      ".hub-page-header__tabs",
    );
    const header = page.locator(".content .content-header.hub-page-header");
    const titleBox = (await header.locator(".page-title").boundingBox())!;
    expect(Math.max(titleBox.width, titleBox.height)).toBeLessThanOrEqual(1);
    const tabs = header.locator(".hub-page-header__tabs");
    await expectAligned(tabs, center(toolbar, "y"), "y");
    await expectAligned(tabs, header, "x");
    const tabsBox = (await tabs.boundingBox())!;
    expect(tabsBox.x).toBeGreaterThan(toolbar.x + toolbar.width);
  });

  it.each(["ltr", "rtl"] as const)(
    "keeps the stacked hub title and tabs below collapsed Mac controls (%s)",
    async (direction) => {
      const { page, toolbar } = await openPage(
        "plugins",
        installNativeWebChrome,
        ".plugins-hub-header",
        {
          methodResponses: {
            "plugins.catalog.browse": discoveryResult,
            "plugins.catalog.categories": discoveryCategories,
          },
        },
        direction,
      );
      const header = page.locator(".plugins-hub-header");
      const title = header.locator(".page-title");
      await expect
        .poll(async () => (await title.boundingBox())?.y ?? -1)
        .toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
      // Read together to avoid comparing different animation frames.
      const { titleBox, introBox, tabsBox } = await header.evaluate((element) => ({
        titleBox: element.querySelector(".page-title")!.getBoundingClientRect().toJSON(),
        introBox: element
          .querySelector(".hub-page-header__title")!
          .getBoundingClientRect()
          .toJSON(),
        tabsBox: element.querySelector(".hub-page-header__tabs")!.getBoundingClientRect().toJSON(),
      }));
      expect(titleBox.height).toBeGreaterThan(1);
      expect(titleBox.width).toBeGreaterThan(1);
      expect(tabsBox.y).toBeGreaterThanOrEqual(introBox.bottom);
      const titleStart = direction === "rtl" ? titleBox.right : titleBox.left;
      const tabsStart = direction === "rtl" ? tabsBox.right : tabsBox.left;
      expect(Math.abs(titleStart - tabsStart)).toBeLessThanOrEqual(1);
      await capture(page, `native-web-collapsed-stacked-header-${direction}.png`);
    },
  );

  it("keeps the legacy Mac app's lowered web controls clear of intro text", async () => {
    const { page } = await openPage("agents", async (target) => {
      await target.addInitScript(() => {
        const stamp = () => document.documentElement.classList.add("openclaw-native-macos");
        if (document.documentElement) {
          stamp();
        } else {
          document.addEventListener("DOMContentLoaded", stamp);
        }
      });
    });
    const controls = (await page.locator(".shell-chrome-controls").boundingBox())!;
    expect(
      await page
        .locator(".shell-chrome-controls button, .shell-chrome-controls a")
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label"))),
    ).toEqual(["Expand sidebar", "Open command palette"]);
    expect(controls.y + controls.height).toBeGreaterThan(52);
    const header = page.locator(".content .content-header").first();
    await expectAligned(header.locator(".page-title"), 25, "y");
    await expect
      .poll(async () => (await header.locator(".page-subtitle").boundingBox())?.y ?? -1)
      .toBeGreaterThanOrEqual(controls.y + controls.height);
  });
});
