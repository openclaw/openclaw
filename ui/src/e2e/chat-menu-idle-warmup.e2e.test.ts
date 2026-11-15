// First open loads menu bodies; reopening retains their ready items.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI chat menu lazy loading" });
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
  it("loads chat menus on first open and reuses their ready bodies", async () => {
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
        const loadingRows = await countLoadingRows(page);
        const sessionMenu = pane.locator("openclaw-chat-header-session-menu");
        const openMenus = async () => {
          await sessionTrigger.click();
          await sessionMenu
            .getByRole("menuitem", { name: "Advanced" })
            .waitFor({ state: "visible" });
          await page.keyboard.press("Escape");
          await plusTrigger.click();
          await pane
            .locator(".agent-chat__capability-menu .oc-menu-item:not([disabled])")
            .first()
            .waitFor({ state: "visible" });
          await page.keyboard.press("Escape");
        };
        await openMenus();
        const firstOpenLoadingRows = await loadingRows();
        await openMenus();
        expect(await loadingRows()).toBe(firstOpenLoadingRows);
      },
    );
  });
});
