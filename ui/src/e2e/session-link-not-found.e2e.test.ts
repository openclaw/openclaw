import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
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
const collisionKey = "agent:main:thread:12345678-0000-4000-8000-000000000001";

async function rememberSession(page: Page, savedSessionKey: string) {
  await page.addInitScript(
    ({ gatewayUrl, settingsKey, sessionKey }) => {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          gatewayUrl,
          sessionsByGateway: { [gatewayUrl]: { sessionKey, lastActiveSessionKey: sessionKey } },
        }),
      );
    },
    {
      gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
      settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
      sessionKey: savedSessionKey,
    },
  );
}

suite.define(() => {
  it.each([
    ["missing session", "agent:main:15cf8259-0000-4000-8000-000000000001", mainKey],
    ["removed agent", "agent:retired:main", mainKey],
    ["colliding short prefix", collisionKey, collisionKey],
  ])("restores the correct chat with a remembered %s", async (_name, savedKey, expectedKey) => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const exact = expectedKey === savedKey;
      const key = savedKey;
      const gateway = await installMockGateway(page, {
        sessions: [],
        mainSessionKey: mainKey,
        methodResponses: exact
          ? {
              "sessions.resolve": {
                cases: [
                  { match: { key }, response: { ok: true, key, agentId: "main" } },
                  {
                    match: { shortId: "12345678" },
                    response: {
                      ok: false,
                      candidates: [key, key.replace(/1$/, "2")].map((candidate) => ({
                        key: candidate,
                        agentId: "main",
                      })),
                    },
                  },
                ],
              },
            }
          : undefined,
      });
      await rememberSession(page, key);
      await page.goto(suite.server.baseUrl);
      if (!exact) {
        await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/main");
      }
      const composer = page.locator(
        exact
          ? ".agent-chat__input textarea"
          : 'openclaw-chat-pane[aria-hidden="false"] .agent-chat__input textarea',
      );
      await composer.waitFor({ state: "visible" });
      expect((await gateway.waitForRequest("chat.startup")).params).toMatchObject({
        sessionKey: expectedKey,
      });
      if (!exact) {
        expect(await composer.count()).toBe(1);
        expect(await page.locator(".session-route-not-found").count()).toBe(0);
        return;
      }
      await expect.poll(() => new URL(page.url()).search).toBe("");
      const requests = await gateway.getRequests("sessions.resolve");
      expect(requests.map(({ params }) => params)).toMatchObject([{ key, allowMissing: true }]);
    });
  });

  it("keeps an explicitly requested missing session as a visible dead end", async () => {
    const savedActiveKey = "agent:main:saved-active-session";
    const attemptedPath = "/chat/main/deadbeef";
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([sessionRow(mainKey, "Main", 1)]),
        },
        mainSessionKey: mainKey,
        sessionKey: savedActiveKey,
      });

      await page.goto(`${suite.server.baseUrl}${attemptedPath.slice(1)}`);
      const state = page.locator(".session-route-not-found");
      await state.getByText("Session not found", { exact: true }).waitFor();
      expect(new URL(page.url()).pathname).toBe(attemptedPath);
      await state
        .getByText("The session may have been removed, or the link may be incorrect.", {
          exact: true,
        })
        .waitFor();
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
      const resolutions = await gateway.getRequests("sessions.resolve");
      expect(resolutions.map(({ params }) => params)).toEqual([
        expect.objectContaining({ shortId: "deadbeef", agentId: "main" }),
        expect.objectContaining({ reference: { key: "agent:main:deadbeef" } }),
      ]);

      await currentSession.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/main");
      await page.locator(".agent-chat__input textarea").waitFor({ state: "visible" });

      await page.goto(`${suite.server.baseUrl}${attemptedPath.slice(1)}`);
      await page.getByRole("button", { name: "View sessions" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/sessions");
      const sessionsHeader = page.locator("openclaw-sessions-page .sessions-hub-header");
      await sessionsHeader.waitFor({ state: "visible" });
      expect(await sessionsHeader.textContent()).toContain("Active sessions and defaults.");
    });
  });
});
