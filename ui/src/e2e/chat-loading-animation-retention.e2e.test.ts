import { webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, navigateToControlUiSession } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { countDetachedWebKitShimmers } from "../test-helpers/control-ui-webkit-animations.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

let browser: Browser;
const suite = createControlUiE2eSuite({
  name: "Control UI loading animation retirement",
  resources: {
    async run() {
      browser = await webkit.launch({ headless: true });
    },
    async close() {
      await browser?.close();
    },
  },
});

suite.define(() => {
  it("does not accumulate detached shimmers as sessions are replaced", async () => {
    const sessions = Array.from({ length: 20 }, (_, index) =>
      createControlUiSessionRow(`agent:main:animation-${index}`, `Session ${index}`, index),
    );
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const context = await browser.newContext({
          ...createControlUiE2eContextOptions(),
          reducedMotion: "no-preference",
        });
        contexts.push(context);
        const page = await context.newPage();
        pages.push(page);
        await installMockGateway(page, { sessions, sessionKey: sessions[0]!.key });
        await page.goto(suite.server.baseUrl + "new");
      }
      for (const [index, page] of pages.entries()) {
        // Match the final three retained panes without aging the control.
        for (const session of index === 0 ? sessions : sessions.slice(-3)) {
          await navigateToControlUiSession(page, session.key);
          const pane = page.locator(".chat-pane-cache__pane--active");
          await expect
            .poll(() => pane.evaluate((node) => Reflect.get(node, "sessionKey")))
            .toBe(session.key);
          await expect
            .poll(() => pane.evaluate((node) => Reflect.get(node, "transcriptReady")))
            .toBe(true);
          await pane.locator("textarea").waitFor();
        }
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
      }
      // Inspect only after churn: connected getAnimations() forces style and
      // changes the short-lived fallback lifecycle that exposed this bug.
      const aged = await countDetachedWebKitShimmers(pages[0]!);
      const fresh = await countDetachedWebKitShimmers(pages[1]!);
      // One initial loading frame may differ; replacement must not add nine per visit.
      expect(aged.detached - fresh.detached).toBeLessThanOrEqual(9);
      expect(aged.running - fresh.running).toBeLessThanOrEqual(9);
    } finally {
      for (const context of contexts) {
        await context.close();
      }
    }
  });
});
