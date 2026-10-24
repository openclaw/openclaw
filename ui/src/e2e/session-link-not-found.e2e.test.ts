import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "missing session link",
  startServerBeforeBrowser: true,
});
const contextOptions = createControlUiE2eContextOptions();
const mainKey = "agent:main:main";

suite.define(() => {
  it("keeps an explicitly requested missing session as a visible dead end", async () => {
    const attemptedPath = "/chat/main/deadbeef";
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([sessionRow(mainKey, "Main", 1)]),
        },
        mainSessionKey: mainKey,
        sessionKey: "agent:main:saved-active-session",
      });

      await page.goto(`${suite.server.baseUrl}${attemptedPath.slice(1)}`);
      const state = page.locator(".session-route-not-found");
      await state.getByText("Session not found", { exact: true }).waitFor();
      expect(new URL(page.url()).pathname).toBe(attemptedPath);
      const currentSession = state.getByRole("button", { name: "Go to main session" });
      const sessions = state.getByRole("button", { name: "View sessions" });
      for (const action of [currentSession, sessions]) {
        const decoration = await action.evaluate((el) => getComputedStyle(el).textDecorationLine);
        expect(decoration).toBe("none");
      }
      const subtitle = state.locator(".lazy-view-error__subtitle");
      expect(await subtitle.evaluate((el) => getComputedStyle(el).textWrap)).toBe("balance");
      const suppressed =
        "openclaw-chat-page, .agent-chat__input textarea, openclaw-toast-host .app-toast";
      expect(await page.locator(suppressed).count()).toBe(0);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(0);

      await currentSession.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/main");
      await page.locator(".agent-chat__input textarea").waitFor({ state: "visible" });

      await page.goto(`${suite.server.baseUrl}${attemptedPath.slice(1)}`);
      await page.getByRole("button", { name: "View sessions" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/sessions");
      const sessionsHeader = page.locator("openclaw-sessions-page .sessions-hub-header");
      await sessionsHeader.waitFor({ state: "visible" });
    });
  });
});
