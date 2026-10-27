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

type Rect = Pick<DOMRect, "x" | "y" | "width" | "height">;
export type ControlRect = Rect &
  Partial<
    Pick<HTMLElement, "clientWidth" | "scrollWidth" | "clientHeight" | "scrollHeight" | "scrollTop">
  > &
  Partial<Pick<CSSStyleDeclaration, "overflow" | "textOverflow" | "display">> & { text?: string };

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
    .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]), { timeout: 5_000 })
    .toEqual([width, height]);
}

export function expectFiniteRect(rect: Rect) {
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
  const styles = `base layout layout.mobile components exec-approval-card
    chat/startup-layout chat/layout chat/message-layout chat/composer-surface
    chat/composer chat/composer-queue chat/composer-queue-content chat/progress-card chat/composer-progress
    chat/composer-context-strip chat/text chat/grouped chat/tool-cards
    chat/working-indicator chat/question-card rail-header
    chat/sidebar chat/sidebar-panels chat/session-rail chat/side-panel`;
  return (cachedUiCss ??= styles
    .split(/\s+/)
    .map((name) => readStyleSheet(`ui/src/styles/${name}.css`))
    .join("\n"));
}

export async function waitForLayoutSettled(page: Page, selector: string): Promise<void> {
  // Container queries/content-visibility need a quiet window, not just matching frames.
  await page.evaluate(async (targetSelector) => {
    let previousGeometry: string | undefined;
    let stableFrames = 0;
    let stableSince = performance.now();
    for (let frame = 0; frame < 60; frame += 1) {
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
      if (stableFrames >= 4 && performance.now() - stableSince >= 50) {
        return;
      }
      previousGeometry = geometry;
    }
    throw new Error(`Layout did not stabilize for ${targetSelector} within 60 frames`);
  }, selector);
}

export async function getRect(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((node) => {
    const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
    return { left, right, top, bottom, width, height };
  });
  expectFiniteRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  return rect;
}

export function rectsOverlap(first: Rect, second: Rect) {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

export async function mountMcpAppSurfaceFixture(page: Page, baseUrl: string) {
  // Keep the server origin for module imports without booting the unrelated app shell.
  await page.route(
    baseUrl,
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><head></head><body></body></html>",
      }),
    { times: 1 },
  );
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({
    type: "module",
    url: new URL("src/components/mcp-app-view.tsx", baseUrl).href,
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
