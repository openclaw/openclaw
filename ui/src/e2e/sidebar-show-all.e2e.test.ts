import { expect, it } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { chooseSidebarOwner } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Show all agents sidebar navigation" });

suite.define(() => {
  it("shows all agents from empty My sessions and other panels, including re-selection and reload", () =>
    suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const agentsList: AgentsListResult = {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }, { id: "research" }],
        };
        await installMockGateway(page, {
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
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        const sidebar = page.locator("openclaw-app-sidebar");
        const groups = sidebar.locator("[data-agent-group]");
        const ownerTitle = sidebar.locator("#sidebar-session-owner-title");
        const shellClass = () => page.locator(".shell").getAttribute("class");
        const switcher = sidebar.locator(
          ".sidebar-agent-card__main, .sidebar-workspace-header__main",
        );
        await chooseSidebarOwner(page, "owner:profile-riley");
        await sidebar.getByText("No active sessions match this filter", { exact: true }).waitFor();
        expect(await ownerTitle.textContent()).toContain("My sessions");
        for (const panel of ["sessions", "pages", "online", "pages"] as const) {
          const tab = sidebar.locator(`[data-navigation-view="${panel}"]`);
          if (panel !== "sessions") {
            await tab.click();
          }
          if (panel === "pages") {
            await tab.click();
            await expect.poll(shellClass).toContain("shell--nav-collapsed");
          }
          await switcher.click();
          await page.getByRole("menuitem", { name: "Show all", exact: true }).click();
          await expect.poll(shellClass).not.toContain("shell--nav-collapsed");
          await expect
            .poll(() =>
              sidebar.locator('[data-navigation-view="sessions"]').getAttribute("aria-pressed"),
            )
            .toBe("true");
          await expect
            .poll(() =>
              groups.evaluateAll((rows) =>
                rows.map((group) => group.getAttribute("data-agent-group")),
              ),
            )
            .toEqual(["main", "research"]);
          await expect.poll(() => groups.first().isVisible()).toBe(true);
          expect(await ownerTitle.textContent()).toContain("My sessions");
        }
        await page.reload();
        await waitForControlUiRoute(page, { routeId: "chat" });
        await expect.poll(() => groups.count()).toBe(2);
      },
    ));
});
