import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("renders and dismisses synthetic catalog-session hovercards", async () => {
    const selectedSessionKey = "agent:main:catalog-selected";
    const catalogSessionKey = "agent:main:catalog:codex:gateway%3Acodex:thread-1";

    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const nowSeconds = Math.floor(Date.now() / 1000);
        await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            "sessions.catalog.list",
          ],
          methodResponses: {
            "progressCard.get": { card: null },
            "sessions.list": chatSessionListResponse([
              { key: selectedSessionKey, kind: "direct", label: "Selected", updatedAt: 1 },
            ]),
            "sessions.catalog.list": {
              catalogs: [
                {
                  id: "codex",
                  label: "Codex",
                  capabilities: { continueSession: true, archive: true },
                  hosts: [
                    {
                      hostId: "gateway:codex",
                      label: "Local Codex",
                      kind: "gateway",
                      connected: true,
                      sessions: [
                        {
                          threadId: "thread-1",
                          name: "Catalog release review",
                          cwd: "/work/openclaw",
                          gitBranch: "catalog-hovercard",
                          createdAt: nowSeconds - 2 * 60 * 60,
                          updatedAt: nowSeconds - 5 * 60,
                          status: "stored",
                          archived: false,
                          canContinue: true,
                          canArchive: true,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        const row = page.locator(`[data-session-key="${catalogSessionKey}"]`);
        await row.waitFor({ state: "visible" });
        await row.hover();
        const card = page.locator(".session-progress-hovercard");
        await card.waitFor({ state: "visible" });
        expect(await card.locator(".session-hovercard__title").textContent()).toBe(
          "Catalog release review",
        );
        expect(await card.locator(".session-hovercard__created-age").textContent()).toBe("2h");
        expect(await card.locator(".session-hovercard__context-text").allTextContents()).toEqual([
          "openclaw",
          "catalog-hovercard",
        ]);
        expect(await card.textContent()).not.toContain("/work/openclaw");

        await row.getByRole("button", { name: "Open session menu" }).dispatchEvent("click");
        await expect.poll(() => card.count()).toBe(0);
        await expect
          .poll(() => page.locator("openclaw-catalog-session-menu").getByRole("menuitem").count())
          .toBeGreaterThan(0);
        await page
          .locator(`[data-session-key="${selectedSessionKey}"]`)
          .dispatchEvent("pointerover", { pointerType: "mouse" });
        await page.waitForTimeout(500);
        expect(await card.count()).toBe(0);
      },
    );
  });
});
