// Browser-level context-menu proof for message text on phone and desktop input.
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

describeControlUiE2e("chat message text context menu", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;
  const artifactDir =
    process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
      ? createControlUiE2eArtifactDir("chat-context-menu-mobile")
      : null;

  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([
    { name: "phone", mobile: true, width: 390, height: 844 },
    { name: "desktop", mobile: false, width: 1280, height: 800 },
  ])(
    "routes $name context menus to the browser or chat actions",
    async ({ name, mobile, width, height }) => {
      const context = await browser.newContext({
        hasTouch: mobile,
        isMobile: mobile,
        serviceWorkers: "block",
        viewport: { width, height },
      });
      try {
        const page = await context.newPage();
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Select part of this message." }],
              timestamp: Date.now(),
              __openclaw: { id: "selection-message", seq: 1 },
            },
          ],
        });
        await page.goto(`${server.baseUrl}chat`);
        const bubble = page.locator('.chat-bubble[data-entry-id="selection-message"]');
        await bubble.waitFor({ state: "visible" });
        const result = await bubble.evaluate((element) => {
          const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
          element.dispatchEvent(event);
          return {
            coarsePointer: window.matchMedia("(hover: none) and (pointer: coarse)").matches,
            defaultPrevented: event.defaultPrevented,
          };
        });
        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, `${name}-text-context-menu.png`),
          });
        }
        expect(result.coarsePointer).toBe(mobile);
        expect(result.defaultPrevented).toBe(!mobile);
        expect(await page.locator(".chat-reply-context-menu").count()).toBe(mobile ? 0 : 1);
      } finally {
        await context.close();
      }
    },
  );
});
