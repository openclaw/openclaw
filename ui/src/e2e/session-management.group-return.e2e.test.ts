import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

async function setThemeMode(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    Object.assign(root.dataset, { themeMode: nextMode, themeResolved: nextMode });
    root.style.colorScheme = nextMode;
  }, mode);
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
}

suite.define(() => {
  it("moves sessions between rendered groups when Person grouping falls back", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const key = "agent:main:planning";
      const rows = [
        sessionRow(key, "Release checklist", 2, { category: "Planning", kind: "group" }),
        sessionRow("agent:main:ready", "Documentation review", 1, { category: "Ready" }),
      ];
      await page.addInitScript(() =>
        localStorage.setItem("openclaw:sidebar:sessions:grouping", "person"),
      );
      const gateway = await support.installMockGateway(page, {
        sessionKey: key,
        sessionGroups: ["Planning", "Ready"],
        sessions: rows,
        methodResponses: {
          // An authoritative roster without multiple owners renders category groups,
          // but must retain the Person preference for later multi-owner rosters.
          "sessions.list": { ...support.sessionsListResponse(rows), owners: [] },
        },
      });
      await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, key));
      const section = (id: string) => page.locator(`[data-session-section="${id}"]`);
      const row = (id: string) => section(id).locator(`[data-session-key="${key}"]`);
      await row("category:Planning").waitFor();
      await chooseSidebarMenuOption(page, "Hide empty groups", "Never");
      await closeSidebarMenu(page);
      await section("groups").waitFor();
      // Start on the visible link: synthetic DragEvents do not prove native acceptance.
      await row("category:Planning")
        .locator(".sidebar-recent-session__link")
        .dragTo(section("category:Ready").locator(".sidebar-recent-sessions__head"));
      await expect.poll(() => gateway.getSessionRow(key)).toMatchObject({ category: "Ready" });
      await row("category:Ready").waitFor();
      await row("category:Ready")
        .locator(".sidebar-recent-session__link")
        .dragTo(section("groups").locator(".sidebar-recent-sessions__head"));
      await expect.poll(() => gateway.getSessionRow(key)).toMatchObject({ category: null });
      await row("groups").waitFor();
      expect(
        (await gateway.getRequests("sessions.patch")).map((request) => request.params),
      ).toEqual([
        { key, agentId: "main", expectedSessionId: rows[0]!.sessionId, category: "Ready" },
        { key, agentId: "main", expectedSessionId: rows[0]!.sessionId, category: null },
      ]);
      expect(
        await page.evaluate(() => localStorage.getItem("openclaw:sidebar:sessions:grouping")),
      ).toBe("person");
      const reads = (await gateway.getRequests("sessions.list")).length;
      await gateway.closeLatest();
      await gateway.waitForRequest("sessions.list", { after: reads });
      await row("groups").waitFor();
    });
  });

  it("moves a categorized group session back to Groups", () =>
    ui.withSessionPage(
      suite,
      async (page) => {
        const key = "agent:main:done-group";
        const rows = [
          sessionRow("agent:main:main", "Main", 2),
          sessionRow(key, "Completed launch", 1, {
            category: "Done",
            kind: "group",
          }),
        ];
        const gateway = await ui.installSessionRows(page, rows, {
          methodResponses: { "sessions.patch": {} },
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "sessions.groups.list",
            "sessions.groups.put",
            "sessions.patch",
          ],
          sessionGroups: ["Done"],
          sessionKey: "agent:main:main",
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await chooseSidebarMenuOption(page, "Status", "All");
        await closeSidebarMenu(page);
        const done = page.locator('[data-session-section="category:Done"]');
        const groups = page.locator('[data-session-section="groups"]');
        const row = done.locator(`[data-session-key="${key}"]`);
        await row.waitFor({ state: "visible", timeout: 10_000 });
        await chooseSidebarMenuOption(page, "Hide empty groups", "Never");
        await closeSidebarMenu(page);
        await groups.waitFor({ state: "visible" });

        await row.hover();
        await row.click({ button: "right" });
        await support.openSessionMenuSubmenu(page, "Move to group");
        await ui.menuItem(page, "Move back to Groups").waitFor({ state: "visible" });
        const capture = (name: string) =>
          support.captureUiProof(suite, page, `sidebar-done-return-${name}.png`);
        await setThemeMode(page, "light");
        await capture("before-light");
        await setThemeMode(page, "dark");
        await capture("before-dark");

        await setThemeMode(page, "light");
        await page.reload();
        await row.waitFor({ state: "visible", timeout: 10_000 });
        await groups.waitFor({ state: "visible" });
        await expect.poll(() => row.getAttribute("draggable")).toBe("true");
        await row.dragTo(groups, {
          sourcePosition: { x: 8, y: 8 },
          targetPosition: { x: 8, y: 8 },
        });
        await ui.sessionPatch(gateway, key, { category: null });
        await ui.visible(groups.locator(`[data-session-key="${key}"]`));
        await capture("after-light");
        await setThemeMode(page, "dark");
        await capture("after-dark");
      },
      { colorScheme: "light" },
    ));
});
