import type { BrowserContext, Locator, Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI page toolbar row E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
let context: BrowserContext | undefined;

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
    const gateway = await installMockGateway(page, gatewayOptions);
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
    return { page, gateway, toolbar: box! };
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
  // Built-in Pages use the stacked hub header; Memory import keeps the toolbar-row title.
  it.each([true, false])("centers page titles and clears controls (native: %s)", async (native) => {
    const { page, toolbar } = await openPage(
      "memory-import",
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
    if (native) {
      expect(toolbar.y + toolbar.height).toBe(52);
      expect(titleBox.x).toBeGreaterThan(toolbar.x + toolbar.width);
      expect((await header.locator(".page-subtitle").boundingBox())!.y).toBeGreaterThanOrEqual(52);
    } else {
      const edges = await page
        .locator(".shell-chrome-controls button:visible")
        .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().right));
      expect(titleBox.x).toBeGreaterThan(Math.max(...edges));
    }
  });

  it.each([
    { width: 1524, height: 864, native: false, narrowColumn: false },
    { width: 1366, height: 768, native: false, narrowColumn: false },
    { width: 768, height: 1024, native: false, narrowColumn: false },
    { width: 768, height: 1024, native: false, narrowColumn: true },
    { width: 390, height: 844, native: false, narrowColumn: false },
    { width: 1524, height: 864, native: true, narrowColumn: false },
  ])(
    "keeps the Templates heading and discovery search reachable at $width×$height (native: $native, narrow: $narrowColumn)",
    async ({ width, height, native, narrowColumn }) => {
      const config = { gateway: { controlUi: { experimental: { templates: true } } } };
      const { page, gateway, toolbar } = await openPage(
        "templates",
        native ? installNativeWebChrome : undefined,
        ".templates-catalog-header",
        {
          featureMethods: [...defaultControlUiFeatureMethods, "templates.catalog.search"],
          methodResponses: {
            "config.get": {
              config,
              sourceConfig: config,
              hash: "templates-header-config",
              valid: true,
              issues: [],
            },
            "templates.catalog.search": { entries: [] },
          },
        },
      );
      await page.setViewportSize({ width, height });
      if (narrowColumn) {
        // Match the content width left during the tablet sidebar transition.
        await page.locator(".templates-catalog-header").evaluate((element) => {
          (element as HTMLElement).style.width = "430px";
        });
      }
      if (width <= 560) {
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--mobile-nav");
      }
      const header = page.locator(".templates-catalog-header");
      const title = header.getByRole("heading", { name: "Templates", exact: true });
      const subtitle = header.locator(".page-subtitle");
      await expect
        .poll(async () => {
          const [heading, intro] = await Promise.all([title.boundingBox(), subtitle.boundingBox()]);
          return heading && intro ? Math.abs(heading.x - intro.x) : Infinity;
        })
        .toBeLessThanOrEqual(1);
      // A viewport change can move the header between separate boundingBox calls.
      const { heading, intro } = await header.evaluate((element) => {
        const box = (selector: string): Box => {
          const rect = element.querySelector(selector)!.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        return { heading: box(".page-title"), intro: box(".page-subtitle") };
      });
      expect(intro.y).toBeGreaterThanOrEqual(heading.y + heading.height);
      expect(intro.y - heading.y - heading.height).toBeLessThanOrEqual(8);
      if (native) {
        expect(heading.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
      }
      const search = page.getByRole("searchbox", { name: "Search Templates", exact: true });
      const { box, introBox } = await search.evaluate((element) => {
        const bounds = (target: Element): Box => {
          const rect = target.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        const introElement = document.querySelector(".templates-catalog-header .page-subtitle")!;
        return { box: bounds(element), introBox: bounds(introElement) };
      });
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      expect(
        box.x + box.width <= introBox.x ||
          box.x >= introBox.x + introBox.width ||
          box.y + box.height <= introBox.y ||
          box.y >= introBox.y + introBox.height,
        `Templates search ${JSON.stringify(box)} overlaps intro ${JSON.stringify(introBox)}`,
      ).toBe(true);
      await search.click({ trial: true });
      await search.fill("workflow");
      await gateway.waitForRequest("templates.catalog.search", { match: { query: "workflow" } });
      expect(new URL(page.url()).pathname).toBe("/templates");
    },
  );

  it.each([
    { width: 1280, height: 900, direction: "ltr" },
    { width: 1280, height: 900, direction: "rtl" },
    { width: 390, height: 844, direction: "ltr" },
  ] as const)(
    "shares a stacked title and aligned tabs across Sessions and Worktrees at $width px ($direction)",
    async ({ width, height, direction }) => {
      const { page, toolbar } = await openPage(
        "sessions",
        installNativeWebChrome,
        ".hub-page-header__tabs",
        { methodResponses: { "worktrees.list": { worktrees: [] } } },
        direction,
      );
      await page.setViewportSize({ width, height });
      if (width <= 560) {
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--mobile-nav");
      }
      const header = page.locator(".content .content-header.hub-page-header");
      const title = header.locator(".page-title");
      await expect.poll(() => title.textContent()).toBe("Sessions");
      const tabs = header.locator(".hub-page-header__tabs");
      const alignment = () =>
        header.evaluate((element) => {
          const titleBox = element.querySelector(".page-title")!.getBoundingClientRect();
          const tabsBox = element.querySelector(".hub-page-header__tabs")!.getBoundingClientRect();
          const edge = getComputedStyle(element).direction === "rtl" ? "right" : "left";
          return {
            titleWidth: titleBox.width,
            titleY: titleBox.y,
            tabsBelowTitle: tabsBox.y >= titleBox.bottom,
            xDelta: Math.abs(tabsBox[edge] - titleBox[edge]),
          };
        });
      const expectAlignedHub = async () => {
        await expect
          .poll(async () => {
            const { titleWidth, tabsBelowTitle, xDelta } = await alignment();
            return titleWidth > 1 && tabsBelowTitle ? xDelta : Infinity;
          })
          .toBeLessThanOrEqual(1);
      };
      await expectAlignedHub();
      if (width > 560) {
        expect((await alignment()).titleY).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
      }
      await tabs.getByRole("tab", { name: "Worktrees" }).click();
      await expect.poll(() => title.textContent()).toBe("Worktrees");
      await expectAlignedHub();
      if (width > 560) {
        await expect
          .poll(async () => (await title.boundingBox())?.y ?? -1)
          .toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
      }
    },
  );

  it("keeps the legacy Mac app's lowered web controls clear of intro text", async () => {
    const { page } = await openPage("memory-import", async (target) => {
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
    ).toEqual(["Expand sidebar", "Command palette"]);
    expect(controls.y + controls.height).toBeGreaterThan(52);
    const header = page.locator(".content .content-header").first();
    await expectAligned(header.locator(".page-title"), 25, "y");
    await expect
      .poll(async () => (await header.locator(".page-subtitle").boundingBox())?.y ?? -1)
      .toBeGreaterThanOrEqual(controls.y + controls.height);
  });
});
