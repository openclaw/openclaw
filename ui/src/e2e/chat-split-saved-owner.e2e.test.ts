import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { ChatSplitLayout } from "../pages/chat/split-layout-types.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { sessionResponseCase } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedChatRoute } from "./new-session-page.test-support.ts";
import { openHomeFullPage } from "./sidebar-navigation.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Saved split conversation owner" });
const homeKey = "agent:main:main";
const composerSelector = ".agent-chat__composer-combobox textarea";
function globalHome(agentId: string) {
  return { ok: true, key: "global", agentId, kind: "global", boardFace: "chat" };
}
const savedLayout: ChatSplitLayout = {
  activePaneId: "confirmed",
  columnWeights: [0.4, 0.6],
  columns: [
    { id: "left", paneWeights: [1], panes: [{ id: "unbound", sessionKey: "global" }] },
    { id: "right", paneWeights: [1], panes: [{ id: "confirmed", sessionKey: homeKey }] },
  ],
};

async function expectUnbound(cell: Locator) {
  expect(await cell.locator("openclaw-chat-pane").count()).toBe(0);
  expect(await cell.textContent()).toContain("Choose a conversation");
}

const paneKeys = (panes: Locator) =>
  panes.evaluateAll((elements) =>
    elements.map((pane) => (pane as HTMLElement & { sessionKey: string }).sessionKey),
  );

suite.define(() => {
  it("keeps a known global Home and its draft when opening split view", async () => {
    await suite.withPage({ viewport: { width: 1600, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionScope: "global",
        assistantAgentId: "research",
        sessions: [{ key: "global", kind: "global", agentId: "research" }],
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "global",
            agents: [{ id: "main" }, { id: "research" }],
          },
          "sessions.resolve": globalHome("research"),
        },
      });
      await page.goto(`${suite.server.baseUrl}chat/research`);
      await waitForCommittedChatRoute(page);
      const composer = page.locator(composerSelector);
      await composer.fill("Keep this Research draft");
      await selectChatLayoutAction(page, "Open split view");
      await expect.poll(() => page.locator(".chat-split-view__cell").count()).toBe(2);
      expect(await page.locator("[data-unbound-pane-id]").count()).toBe(0);
      await expect.poll(() => composer.first().inputValue()).toBe("Keep this Research draft");
      expect(
        await paneKeys(page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible")),
      ).toEqual(["agent:research:main", "agent:research:main"]);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it.each(["per-sender", "global"] as const)(
    "keeps an ownerless saved pane unbound until same-route Home explicitly selects it (%s scope)",
    async (sessionScope) => {
      await suite.withPage({ viewport: { width: 1600, height: 1000 } }, async ({ page }) => {
        const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        await page.addInitScript(
          ({ key, layout }) => {
            if (sessionStorage.getItem("saved-pane-seeded")) {
              return;
            }
            sessionStorage.setItem("saved-pane-seeded", "true");
            localStorage.setItem(key, JSON.stringify({ chatSplitLayout: layout }));
          },
          { key: storageKey, layout: savedLayout },
        );
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const gateway = await installMockGateway(page, {
          // The final reload has only an unbound pane; selecting Home releases the roster.
          awaitInitialRoster: false,
          sessionKey: homeKey,
          sessionScope,
          methodResponses:
            sessionScope === "global"
              ? {
                  "sessions.resolve": sessionResponseCase(
                    { reference: { key: homeKey } },
                    globalHome("main"),
                  ),
                }
              : {},
          sessions: [{ key: homeKey, kind: "direct", displayName: "Confirmed Home", updatedAt: 1 }],
          historyMessages: [{ role: "assistant", content: "Main history", timestamp: 1 }],
        });
        await page.goto(
          `${suite.server.baseUrl}chat/main${sessionScope === "global" ? "?draft=Scoped%20Home%20draft" : ""}`,
        );
        await waitForCommittedChatRoute(page);
        const cells = page.locator(".chat-split-view__cell");
        const unbound = cells.first();
        const pane = unbound.locator("openclaw-chat-pane");
        await expect.poll(() => cells.count()).toBe(2);
        await page.locator(composerSelector).last().waitFor({ state: "visible" });
        await expectUnbound(unbound);
        if (sessionScope === "global") {
          await expect
            .poll(() => cells.last().locator(composerSelector).inputValue())
            .toBe("Scoped Home draft");
        }
        if (sessionScope !== "global") {
          for (const method of ["chat.history", "chat.startup", "sessions.messages.subscribe"]) {
            expect(await gateway.getRequests(method, { sessionKey: "global" })).toEqual([]);
            expect(await gateway.getRequests(method, { key: "global" })).toEqual([]);
          }
        }
        const currentUrl = page.url();
        await unbound.click();
        expect(page.url()).toBe(currentUrl);
        await evaluateControlUiContext(page, (context) => context.revalidate("chat"));
        await waitForCommittedChatRoute(page);
        expect(await pane.count()).toBe(0);
        await openHomeFullPage(page);
        await expect.poll(() => paneKeys(pane)).toEqual([homeKey]);
        await waitForCommittedChatRoute(page);
        await expect.poll(() => page.url()).toBe(currentUrl);
        const persisted = await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "null").chatSplitLayout,
          storageKey,
        );
        expect(persisted).toEqual({
          ...savedLayout,
          activePaneId: "unbound",
          columns: [
            { ...savedLayout.columns[0], panes: [{ id: "unbound", sessionKey: homeKey }] },
            savedLayout.columns[1],
          ],
        });
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(errors).toEqual([]);
        await navigateToControlUiSession(page, "agent:research:global");
        await waitForCommittedChatRoute(page);
        await expect
          .poll(() =>
            paneKeys(unbound.locator("openclaw-chat-pane.chat-pane-cache__pane--visible")),
          )
          .toEqual(["agent:research:global"]);
        expect(new URL(page.url()).pathname).toBe("/chat/research/~key/global");

        // A close must not silently reopen the bound conversation in the surviving unknown pane.
        await page.evaluate(
          ({ key, layout }) => {
            const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
            localStorage.setItem(key, JSON.stringify({ ...settings, chatSplitLayout: layout }));
          },
          { key: storageKey, layout: savedLayout },
        );
        await page.goto(`${suite.server.baseUrl}chat/main`);
        await waitForCommittedChatRoute(page);
        await selectChatLayoutAction(cells.last(), "Close pane");
        await expect.poll(() => cells.count()).toBe(1);
        await expectUnbound(unbound);
        await expect
          .poll(() =>
            page.evaluate(() => document.activeElement?.getAttribute("data-unbound-pane-id")),
          )
          .toBe("unbound");
        await page.reload();
        await waitForCommittedChatRoute(page);
        expect(await cells.count()).toBe(1);
        await expectUnbound(unbound);
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.locator(".sidebar-agent-card__main").click();
        await sidebar.locator('.sidebar-agent-menu [data-value="agent:main"]').click();
        const visiblePane = cells
          .first()
          .locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        await expect.poll(() => visiblePane.count()).toBe(1);
        await expect
          .poll(() => visiblePane.locator(composerSelector).inputValue())
          .toBe(sessionScope === "global" ? "Scoped Home draft" : "");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(errors).toEqual([]);
      });
    },
  );
});
