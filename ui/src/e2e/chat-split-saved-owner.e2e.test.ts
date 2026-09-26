import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import type { ChatSplitLayout } from "../pages/chat/split-layout-types.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedChatRoute } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Saved split conversation owner" });
const homeKey = "agent:main:main";
const savedLayout: ChatSplitLayout = {
  activePaneId: "confirmed",
  columnWeights: [0.4, 0.6],
  columns: [
    { id: "left", paneWeights: [1], panes: [{ id: "unbound", sessionKey: "global" }] },
    { id: "right", paneWeights: [1], panes: [{ id: "confirmed", sessionKey: homeKey }] },
  ],
};

suite.define(() => {
  it("keeps a known global Home and its draft when opening split view", async () => {
    await suite.withPage({ viewport: { width: 1600, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: "global",
        sessionScope: "global",
        mainSessionKey: "global",
        defaultAgentId: "main",
        assistantAgentId: "research",
        sessions: [
          {
            key: "global",
            kind: "global",
            agentId: "research",
            displayName: "Research Home",
            updatedAt: 1,
          },
        ],
        featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.startup"],
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "global",
            agents: [{ id: "main" }, { id: "research" }],
          },
          "sessions.resolve": {
            ok: true,
            key: "global",
            agentId: "research",
            kind: "global",
            boardFace: "chat",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat/research`);
      await waitForCommittedChatRoute(page);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Keep this Research draft");
      await page.getByRole("button", { name: "Open split view", exact: true }).click();
      await expect.poll(() => page.locator(".chat-split-view__cell").count()).toBe(2);
      expect(await page.locator("[data-unbound-pane-id]").count()).toBe(0);
      await expect.poll(() => composer.first().inputValue()).toBe("Keep this Research draft");
      expect(
        await page
          .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
          .evaluateAll((panes) =>
            panes.map((pane) => (pane as HTMLElement & { sessionKey: string }).sessionKey),
          ),
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
          sessionKey: homeKey,
          sessionScope,
          mainSessionKey: sessionScope === "global" ? "global" : homeKey,
          methodResponses:
            sessionScope === "global"
              ? {
                  "sessions.resolve": {
                    cases: [
                      {
                        match: { reference: { key: homeKey } },
                        response: {
                          ok: true,
                          key: "global",
                          agentId: "main",
                          kind: "global",
                          boardFace: "chat",
                        },
                      },
                    ],
                  },
                }
              : {},
          sessions: [{ key: homeKey, kind: "direct", displayName: "Confirmed Home", updatedAt: 1 }],
          featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.startup"],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Main conversation history" }],
              timestamp: 1,
            },
          ],
        });
        await page.goto(
          `${suite.server.baseUrl}chat/main${sessionScope === "global" ? "?draft=Scoped%20Home%20draft" : ""}`,
        );
        await waitForCommittedChatRoute(page);
        const cells = page.locator(".chat-split-view__cell");
        await expect.poll(() => cells.count()).toBe(2);
        await page
          .locator(".agent-chat__composer-combobox textarea")
          .last()
          .waitFor({ state: "visible" });
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "restored.png"),
            animations: "disabled",
          });
        }
        expect(await cells.first().locator("openclaw-chat-pane").count()).toBe(0);
        expect(await cells.first().textContent()).toContain("Choose a conversation");
        if (sessionScope === "global") {
          await expect
            .poll(() =>
              cells.last().locator(".agent-chat__composer-combobox textarea").inputValue(),
            )
            .toBe("Scoped Home draft");
        }
        for (const method of ["chat.history", "chat.startup", "sessions.messages.subscribe"]) {
          expect(
            (await gateway.getRequests(method)).filter((request) => {
              const params = asOptionalRecord(request.params);
              return (
                sessionScope !== "global" &&
                (params?.sessionKey === "global" || params?.key === "global")
              );
            }),
          ).toHaveLength(0);
        }
        const currentUrl = page.url();
        await cells.first().click();
        expect(page.url()).toBe(currentUrl);
        await page.evaluate(async () => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: { context: ApplicationContext };
          };
          await app.runtime.context.revalidate("chat");
        });
        await waitForCommittedChatRoute(page);
        expect(await cells.first().locator("openclaw-chat-pane").count()).toBe(0);
        await page.locator(".nav-item--home").click();
        await expect
          .poll(() =>
            cells
              .first()
              .locator("openclaw-chat-pane")
              .evaluateAll((panes) =>
                panes.map((pane) => (pane as HTMLElement & { sessionKey: string }).sessionKey),
              ),
          )
          .toEqual([homeKey]);
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
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "recovered.png"),
            animations: "disabled",
          });
        }
        await navigateToControlUiSession(page, "agent:research:global");
        await waitForCommittedChatRoute(page);
        await expect
          .poll(() =>
            cells
              .first()
              .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
              .evaluate((pane) => (pane as HTMLElement & { sessionKey: string }).sessionKey),
          )
          .toBe("agent:research:global");
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
        await cells.last().getByRole("button", { name: "Close pane", exact: true }).click();
        await expect.poll(() => cells.count()).toBe(1);
        expect(await cells.first().locator("openclaw-chat-pane").count()).toBe(0);
        expect(await cells.first().textContent()).toContain("Choose a conversation");
        await expect
          .poll(() =>
            page.evaluate(() => document.activeElement?.getAttribute("data-unbound-pane-id")),
          )
          .toBe("unbound");
        await page.reload();
        await waitForCommittedChatRoute(page);
        expect(await cells.count()).toBe(1);
        expect(await cells.first().locator("openclaw-chat-pane").count()).toBe(0);
        expect(await cells.first().textContent()).toContain("Choose a conversation");
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.locator(".sidebar-agent-card__main").click();
        await sidebar
          .locator('wa-dropdown.sidebar-agent-menu wa-dropdown-item[value="command:capabilities"]')
          .click();
        await expect.poll(() => cells.first().locator("openclaw-chat-pane").count()).toBe(1);
        await expect
          .poll(() => cells.first().locator(".agent-chat__composer-combobox textarea").inputValue())
          .toBe("What can you do?");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(errors).toEqual([]);
      });
    },
  );
});
