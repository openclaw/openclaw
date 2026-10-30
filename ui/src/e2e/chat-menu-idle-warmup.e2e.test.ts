// After a chat settles, its menu bodies are already loaded: first open shows real items.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI chat menu idle warmup" });
const sessionKey = "agent:main:main";
// Lazy-body fallbacks only; owner and people rows load their own data on open.
const fallbacks = '[data-value="header-session-loading"], [data-value="plus-menu-loading"]';

// Counts loading rows still attached when the next frame starts, so they would paint.
// Rows a menu replaces within the opening task never reach the screen.
async function countLoadingRows(page: Page) {
  await page.evaluate((selector) => {
    let count = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          const row =
            node instanceof Element
              ? node.matches(selector)
                ? node
                : node.querySelector(selector)
              : null;
          if (row) {
            requestAnimationFrame(() => {
              if (row.isConnected) {
                document.documentElement.dataset.menuLoadingRows = String(++count);
              }
            });
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }, fallbacks);
  return () => page.locator("html").getAttribute("data-menu-loading-rows");
}

suite.define(() => {
  it("opens chat menus without a loading row once the page is idle", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup"],
          historyMessages: [],
          methodResponses: {
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "Warm menus",
                sessionId: "session-warm-menus",
                updatedAt: Date.now(),
              },
            ]),
          },
          operatorScopes: ["operator.read", "operator.write"],
          sessionKey,
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const sessionTrigger = pane.getByRole("button", { name: "Actions for Warm menus" });
        const plusTrigger = pane.getByRole("button", { name: "Add attachment" });
        await sessionTrigger.waitFor({ state: "visible" });
        await plusTrigger.waitFor({ state: "visible" });
        // The shell's idle owner loads registered menu bodies after the transcript
        // settles, then the bodies those register. Only a fallback still pending at
        // open is user-visible, so let that chain finish before interacting.
        await expect
          .poll(
            () =>
              page.evaluate(() =>
                ["chat-header-session-menu-content", "chat-composer-plus-menu-content"].every(
                  (name) =>
                    performance
                      .getEntriesByType("resource")
                      .some((entry) => entry.name.includes(name)),
                ),
              ),
            { timeout: 15_000 },
          )
          .toBe(true);
        let resources = -1;
        let quietSince = Date.now();
        await expect
          .poll(
            async () => {
              const count = await page.evaluate(
                () => performance.getEntriesByType("resource").length,
              );
              if (count !== resources) {
                resources = count;
                quietSince = Date.now();
              }
              return Date.now() - quietSince;
            },
            { timeout: 15_000, interval: 100 },
          )
          .toBeGreaterThan(1_500);
        const loadingRows = await countLoadingRows(page);

        await sessionTrigger.click();
        const sessionMenu = pane.locator("openclaw-chat-header-session-menu");
        await sessionMenu.getByRole("menuitem", { name: "Advanced" }).waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await plusTrigger.click();
        await pane
          .locator(".agent-chat__capability-menu .oc-menu-item:not([disabled])")
          .first()
          .waitFor({ state: "visible" });
        expect(await loadingRows()).toBeNull();
      },
    );
  });
});
