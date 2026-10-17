import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import { closeBrowserPage } from "../../test-helpers/browser-page.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../test-helpers/control-ui-e2e.ts";

export const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(
  chromium.executablePath(),
);
export const canRunChatLayoutBrowser = canRunPlaywrightChromium(chromiumExecutablePath);
let cachedUiCss: string | null = null;

export type ControlRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  clientWidth?: number;
  scrollWidth?: number;
  clientHeight?: number;
  scrollHeight?: number;
  overflow?: string;
  textOverflow?: string;
  scrollTop?: number;
  text?: string;
  display?: string;
};

export function createChatLayoutBrowser() {
  let sharedBrowser: Browser | null = null;
  let sharedLayoutContext: BrowserContext | null = null;

  async function start(): Promise<void> {
    sharedBrowser = await chromium.launch({
      executablePath: chromiumExecutablePath,
      headless: true,
    });
    sharedLayoutContext = await sharedBrowser.newContext();
  }

  async function openBrowserPage(
    width: number,
    height: number,
    options: { hasTouch?: boolean; isolated?: boolean } = {},
  ): Promise<Page> {
    if (!sharedBrowser || !sharedLayoutContext) {
      throw new Error("Expected the chat layout browser to be ready");
    }
    let page: Page | undefined;
    try {
      if (options.isolated) {
        page = await sharedBrowser.newPage({
          hasTouch: options.hasTouch,
          viewport: { width, height },
        });
      } else {
        // Static setContent fixtures do not mutate context-owned storage or routes,
        // so they can share one context while their pages remain concurrent.
        page = await sharedLayoutContext.newPage();
        await page.setViewportSize({ width, height });
      }
      await waitForViewportSize(page, width, height);
      return page;
    } catch (error) {
      if (page) {
        await closeBrowserPage(page);
      }
      throw error;
    }
  }

  async function close(): Promise<void> {
    await sharedLayoutContext?.close();
    sharedLayoutContext = null;
    await sharedBrowser?.close();
    sharedBrowser = null;
  }

  return { start, openBrowserPage, close };
}

async function waitForViewportSize(page: Page, width: number, height: number) {
  await expectBrowser
    .poll(
      () =>
        page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        })),
      { timeout: 5_000 },
    )
    .toEqual({ width, height });
}

export function expectFiniteRect(rect: Pick<ControlRect, "x" | "y" | "width" | "height">) {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Number.isFinite(rect[key])).toBe(true);
  }
}

export async function getBoundingBox(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`Expected bounding box for ${selector}`);
  }
  expectFiniteRect(box);
  return box;
}

export function readUiCss(): string {
  if (cachedUiCss !== null) {
    return cachedUiCss;
  }
  const files = [
    "ui/src/styles/base.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/layout.mobile.css",
    "ui/src/styles/components.css",
    "ui/src/styles/chat/startup-layout.css",
    "ui/src/styles/chat/layout.css",
    "ui/src/styles/chat/message-layout.css",
    "ui/src/styles/chat/composer-surface.css",
    "ui/src/styles/chat/composer.css",
    "ui/src/styles/chat/composer-queue.css",
    "ui/src/styles/chat/progress-card.css",
    "ui/src/styles/chat/composer-progress.css",
    "ui/src/styles/chat/composer-context-strip.css",
    "ui/src/styles/chat/text.css",
    "ui/src/styles/chat/grouped.css",
    "ui/src/styles/chat/tool-cards.css",
    "ui/src/styles/chat/working-indicator.css",
    "ui/src/styles/chat/question-card.css",
    "ui/src/styles/rail-header.css",
    "ui/src/styles/chat/sidebar.css",
    "ui/src/styles/chat/session-rail.css",
    "ui/src/styles/chat/side-panel.css",
  ];
  cachedUiCss = files.map((file) => readStyleSheet(file)).join("\n");
  return cachedUiCss;
}

export async function waitForLayoutSettled(page: Page, selector: string): Promise<void> {
  // content-visibility and container queries can defer descendant layout beyond
  // a fixed rAF pair. Require a short quiet window so a delayed update cannot
  // land immediately after two coincidentally identical frames.
  await page.evaluate(
    async ({ maxFrames, minStableFrames, minStableMs, selector: targetSelector }) => {
      let previousGeometry: string | undefined;
      let stableFrames = 0;
      let stableSince = performance.now();
      for (let frame = 0; frame < maxFrames; frame += 1) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        const elements = [...document.querySelectorAll<HTMLElement>(targetSelector)];
        if (elements.length === 0) {
          throw new Error(`No layout elements matched ${targetSelector}`);
        }
        const geometry = JSON.stringify(
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          }),
        );
        if (geometry === previousGeometry) {
          stableFrames += 1;
        } else {
          stableFrames = 1;
          stableSince = performance.now();
        }
        if (stableFrames >= minStableFrames && performance.now() - stableSince >= minStableMs) {
          return;
        }
        previousGeometry = geometry;
      }
      throw new Error(`Layout did not stabilize for ${targetSelector} within ${maxFrames} frames`);
    },
    { maxFrames: 60, minStableFrames: 4, minStableMs: 50, selector },
  );
}

export async function getRect(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((node) => {
    const bounds = (node as HTMLElement).getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      width: bounds.width,
      height: bounds.height,
    };
  });
  expectFiniteRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  return rect;
}

export function rectsOverlap(
  first: Pick<ControlRect, "x" | "y" | "width" | "height">,
  second: Pick<ControlRect, "x" | "y" | "width" | "height">,
) {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

export async function mountMcpAppSurfaceFixture(page: Page, baseUrl: string) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({
    type: "module",
    url: new URL("src/components/mcp-app-view-registration.ts", baseUrl).href,
  });
  const fixtureUrl = new URL("src/pages/chat/components/chat-sidebar.test-support.ts", baseUrl)
    .href;
  return page.evaluateHandle(`(async () => {
    const { createChatSidebarContainer } = await import(${JSON.stringify(fixtureUrl)});
    const owner = createChatSidebarContainer();
    document.body.replaceChildren(owner);
    return owner;
  })()`);
}
