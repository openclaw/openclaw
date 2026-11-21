import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  ownerRoster,
  sessionPerson,
  sessionsList,
} from "./session-ownership-fixtures.test-support.ts";
import {
  openSidebarSortMenu,
  routeAvatarFixtures,
} from "./session-ownership-visuals.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";
import {
  chooseSidebarMenuOption,
  chooseSidebarOwner,
  closeSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI toolbar owner filter" });

suite.define(() => {
  it("intersects owner filters and personal pins with the selected agent until Show all", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 800 }, locale: "en-US" },
      async ({ page }) => {
        const self = sessionPerson("profile-riley", "Riley");
        const other = sessionPerson("profile-devon", "Devon");
        const rows = [
          { agentId: "main", id: "release-notes", label: "Roboclaw · Release notes", actor: self },
          {
            agentId: "research",
            id: "customer-interviews",
            label: "X front door · Reply drafts",
            actor: self,
          },
          { agentId: "main", id: "design-review", label: "Roboclaw · Design review", actor: other },
          { agentId: "main", id: "sidebar", label: "Roboclaw · Sidebar filters", actor: self },
          {
            agentId: "research",
            id: "mentions",
            label: "X front door · Mention triage",
            actor: self,
          },
        ].map(({ agentId, id, label, actor }, index) =>
          createControlUiSessionRow(`agent:${agentId}:${id}`, label, Date.now() - index, {
            agentId,
            owner: { actor },
            createdActor: actor,
          }),
        );
        const response = (selected: typeof rows) => ownerRoster(selected, [self, other]);
        const gateway = await installMockGateway(page, {
          sessionKey: rows[0]!.key,
          sessions: rows,
          presenceUsers: [{ self: true, id: self.id, name: self.label }],
          historyMessages: [
            { role: "assistant", content: "The release notes are ready for review." },
          ],
          methodResponses: {
            "agents.list": agentRoster(
              { main: "Roboclaw", research: "Roboclaw (X front door)" },
              "main",
              "per-sender",
            ),
            "sessions.list": {
              cases: [
                {
                  match: { agentId: "main", ownerId: self.id },
                  response: response([rows[0]!, rows[3]!]),
                },
                {
                  match: { agentId: "research", ownerId: self.id },
                  response: response([rows[1]!, rows[4]!]),
                },
                { match: { agentId: "main", ownerId: other.id }, response: response([rows[2]!]) },
                { match: { agentId: "research", ownerId: other.id }, response: response([]) },
                {
                  match: { ownerId: self.id },
                  response: response([rows[0]!, rows[1]!, rows[3]!, rows[4]!]),
                },
                { match: { ownerId: other.id }, response: response([rows[2]!]) },
                { match: { agentId: "main" }, response: response([rows[0]!, rows[2]!, rows[3]!]) },
                { match: { agentId: "research" }, response: response([rows[1]!, rows[4]!]) },
                { response: response(rows) },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, rows[0]!.key));
        const sidebar = page.locator("openclaw-app-sidebar");
        const row = (index: number) =>
          sidebar.locator(`[data-session-key="${rows[index]!.key}"]`).first();
        const switchAgent = async (id: string) => {
          await sidebar
            .locator(".sidebar-agent-card__main, .sidebar-workspace-header__main")
            .click();
          await sidebar.locator(`[data-value="agent:${id}"]`).click();
        };
        await expectBrowser(row(0)).toBeVisible();
        const resizer = page.getByRole("separator", { name: "Resize sidebar" });
        await resizer.focus();
        await page.keyboard.press("End");
        await expectBrowser(resizer).toHaveAttribute("aria-valuetext", "452 pixels");
        await row(0).locator(".sidebar-recent-session__link").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Pin session", exact: true }).click();
        await switchAgent("research");
        await expectBrowser(row(1)).toBeVisible();
        await row(1).locator(".sidebar-recent-session__link").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Pin session", exact: true }).click();
        await expectBrowser(sidebar.locator('[data-session-section="pinned"]')).toBeVisible();
        await switchAgent("main");
        await chooseSidebarOwner(page, `owner:${self.id}`);
        await expectBrowser(row(0)).toBeVisible();
        await gateway.waitForRequest("sessions.list", { match: { ownerId: self.id } });
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const surface = page.locator(".shell-nav");
          const frame = await takeControlUiScreenshotFrame(page, surface, [row(0)], {
            elements: [surface],
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, "selected-agent.png"), frame.png);
          await writeFile(
            path.join(suite.artifactDir, "selected-agent-sidebar.png"),
            frame.elements[0]!.png,
          );
          await sidebar.locator(".sidebar-agent-card__main").click();
          const selected = sidebar.locator('[data-value="agent:main"][aria-current="true"]');
          await expectBrowser(selected).toBeVisible();
          const menu = sidebar.locator(".sidebar-agent-menu");
          const selection = await takeControlUiScreenshotFrame(page, menu, [selected], {
            elements: [menu],
            animations: "disabled",
          });
          await writeFile(
            path.join(suite.artifactDir, "agent-selection.png"),
            selection.elements[0]!.png,
          );
          await page.keyboard.press("Escape");
        }
        await expectBrowser(row(1)).toHaveCount(0);
        await expectBrowser(row(4)).toHaveCount(0);
        await expectBrowser(row(3)).toBeVisible();
        await expectBrowser(row(2)).toHaveCount(0);
        await chooseSidebarOwner(page, "all");
        await expectBrowser(row(2)).toBeVisible();
        await expectBrowser(row(1)).toHaveCount(0);
        await chooseSidebarOwner(page, `owner:${other.id}`);
        await expectBrowser(row(2)).toBeVisible();
        await expectBrowser(row(3)).toHaveCount(0);
        await switchAgent("research");
        await expectBrowser(
          sidebar.getByText("No active sessions match this filter", { exact: true }),
        ).toBeVisible();
        await chooseSidebarOwner(page, `owner:${self.id}`);
        await expectBrowser(row(1)).toBeVisible();
        await expectBrowser(row(4)).toBeVisible();
        await expectBrowser(row(0)).toHaveCount(0);
        await switchAgent("main");
        await expectBrowser(row(0)).toBeVisible();
        await sidebar.locator(".sidebar-agent-card__main").click();
        await page.getByRole("menuitem", { name: "Show all", exact: true }).click();
        await expectBrowser(sidebar.locator('[data-agent-group="main"]')).toBeVisible();
        await expectBrowser(sidebar.locator('[data-agent-group="research"]')).toBeVisible();
        await expectBrowser(row(1)).toBeVisible();
        await expectBrowser(sidebar.locator("#sidebar-session-owner-title")).toContainText(
          "My sessions",
        );
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const surface = page.locator(".shell-nav");
          const frame = await takeControlUiScreenshotFrame(page, surface, [row(0), row(1)], {
            elements: [surface],
            animations: "disabled",
          });
          await writeFile(
            path.join(suite.artifactDir, "show-all-sidebar.png"),
            frame.elements[0]!.png,
          );
        }
      },
    );
  });

  it("filters grouped sessions from the toolbar without duplicate header controls", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const response = sessionsList(undefined, true, { categories: false, actorAvatars: true });
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-patrick", name: "Patrick" }],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { ownerId: "profile-ada" },
              response: { ...response, count: 1, sessions: [response.sessions[0]] },
            },
            { response },
          ],
        },
      },
    });

    try {
      await routeAvatarFixtures(page, [
        { id: "profile-ada", background: "#3f6f76", label: "A" },
        { id: "profile-bob", background: "#985b42", label: "B" },
      ]);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
      await selectAllSidebarSessions(page);
      const menu = await openSidebarSortMenu(page);
      await chooseSidebarMenuOption(menu.page(), "Group by", "Person");
      await closeSidebarMenu(page);
      const adaSection = page.locator('[data-session-section="person:profile:profile-ada"]');
      const bobSection = page.locator('[data-session-section="person:profile:profile-bob"]');
      await expectBrowser(adaSection).toBeVisible();
      await expectBrowser(bobSection).toBeVisible();

      const header = adaSection.locator(".sidebar-recent-sessions__head");
      await header.hover();
      await expectBrowser(header.locator(".sidebar-session-group-actions")).toHaveCount(0);
      const filterMatch = { ownerId: "profile-ada" };
      const beforeFilter = (await gateway.getRequests("sessions.list", filterMatch)).length;
      await chooseSidebarOwner(page, "owner:profile-ada");
      await closeSidebarMenu(page);
      await gateway.waitForRequest("sessions.list", { match: filterMatch, after: beforeFilter });
      await expectBrowser(bobSection).toHaveCount(0);
      await expectBrowser(adaSection.getByText("Ada research", { exact: true })).toBeVisible();
      const ownerChip = page.locator("#sidebar-session-owner-title");
      const funnel = page.getByRole("button", { name: /^Filter & sort · /, exact: true });
      await expectBrowser(ownerChip).toBeVisible();
      await expectBrowser(ownerChip.locator(".picker-select__label")).toHaveText("Ada");
      await expectBrowser(ownerChip).toHaveAccessibleName("Owners: Ada");
      await expectBrowser(funnel).not.toHaveClass(/sidebar-session-sort--filtered/);
      await expectBrowser(header.locator(".sidebar-session-group-actions")).toHaveCount(0);

      const beforeClear = (await gateway.getRequests("sessions.list")).length;
      await selectAllSidebarSessions(page);
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).slice(beforeClear).some((request) => {
            const params = request.params as { ownerId?: unknown; involvingMe?: unknown };
            return params.ownerId === undefined && params.involvingMe === undefined;
          }),
        )
        .toBe(true);
      await expectBrowser(bobSection).toBeVisible();
      await expectBrowser(ownerChip.locator(".picker-select__label")).toHaveText("All owners");
      await expectBrowser(funnel).not.toHaveClass(/sidebar-session-sort--filtered/);
      await expectBrowser(header.locator(".sidebar-session-group-actions")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
