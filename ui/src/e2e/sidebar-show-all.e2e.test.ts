import { expect, it } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";
import { chooseSidebarOwner } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Show all agents sidebar navigation" });

suite.define(() => {
  it("shows all agents from empty My sessions and other panels, including re-selection and reload", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const agentsList: AgentsListResult = {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", name: "Harbor" },
            { id: "research", name: "Research" },
          ],
        };
        await installMockGateway(page, {
          sessions: [],
          presenceUsers: [{ self: true, id: "profile-riley", name: "Riley" }],
          methodResponses: {
            "sessions.list": {
              ts: Date.now(),
              path: "",
              count: 0,
              sessions: [],
              defaults: { model: null, modelProvider: null, contextTokens: null },
              owners: [
                { type: "human", id: "profile-riley", label: "Riley" },
                { type: "human", id: "profile-devon", label: "Devon" },
              ],
            },
            "agents.list": agentsList,
            "chat.startup": {
              agentsList,
              messages: [],
              metadata: { models: [] },
              sessionId: "session:agent:main:main",
              thinkingLevel: null,
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        const sidebar = page.locator("openclaw-app-sidebar");
        const switcher = sidebar.locator(
          ".sidebar-agent-card__main, .sidebar-workspace-header__main",
        );
        await switcher.waitFor();
        await chooseSidebarOwner(page, "owner:profile-riley");
        await sidebar.getByText("No active sessions match this filter", { exact: true }).waitFor();
        expect(await sidebar.locator("#sidebar-session-owner-title").textContent()).toContain(
          "My sessions",
        );
        await captureSidebarUiProof(suite, page, "empty-my-sessions.png");
        for (const panel of ["sessions", "pages", "online", "pages"] as const) {
          const tab = sidebar.locator(`[data-navigation-view="${panel}"]`);
          if (panel !== "sessions") {
            await tab.click();
          }
          if (panel === "pages") {
            await tab.click();
            await expect
              .poll(() => page.locator(".shell").getAttribute("class"))
              .toContain("shell--nav-collapsed");
          }
          await switcher.click();
          await page.getByRole("menuitem", { name: "Show all", exact: true }).click();
          await waitForControlUiRoute(page, { routeId: "sessions", pathname: "/sessions" });
          await expect
            .poll(() => page.locator(".shell").getAttribute("class"))
            .not.toContain("shell--nav-collapsed");
          await expect
            .poll(() =>
              sidebar.locator('[data-navigation-view="sessions"]').getAttribute("aria-pressed"),
            )
            .toBe("true");
          await expect
            .poll(() =>
              sidebar
                .locator("[data-agent-group]")
                .evaluateAll((groups) =>
                  groups.map((group) => group.getAttribute("data-agent-group")),
                ),
            )
            .toEqual(["main", "research"]);
          await expect
            .poll(() => sidebar.locator("[data-agent-group]").first().isVisible())
            .toBe(true);
          expect(await sidebar.locator("#sidebar-session-owner-title").textContent()).toContain(
            "My sessions",
          );
          if (panel === "sessions") {
            await captureSidebarUiProof(suite, page, "all-agents-empty-my-sessions.png");
          }
        }
        await page.reload();
        await waitForControlUiRoute(page, { routeId: "sessions", pathname: "/sessions" });
        await expect.poll(() => sidebar.locator("[data-agent-group]").count()).toBe(2);
      },
    );
  });
});
