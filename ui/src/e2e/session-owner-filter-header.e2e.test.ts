import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  openSidebarSortMenu,
  routeAvatarFixtures,
} from "./session-ownership-visuals.test-support.ts";
import {
  chooseSidebarMenuOption,
  chooseSidebarOwner,
  closeSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI toolbar owner filter" });

function sessionsList() {
  const ada = {
    type: "human" as const,
    id: "profile-ada",
    identity: { type: "profile" as const, id: "profile-ada" },
    label: "Ada",
    avatarUrl: "/api/users/profile-ada/avatar?v=1",
  };
  const bob = {
    type: "human" as const,
    id: "profile-bob",
    identity: { type: "profile" as const, id: "profile-bob" },
    label: "Bob",
    avatarUrl: "/api/users/profile-bob/avatar?v=1",
  };
  return {
    count: 2,
    owners: [ada, bob],
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        key: "agent:main:ada",
        kind: "direct",
        label: "Ada research",
        createdActor: ada,
        owner: { actor: ada },
        updatedAt: 2,
      },
      {
        key: "agent:main:bob",
        kind: "direct",
        label: "Bob operations",
        createdActor: bob,
        owner: { actor: bob },
        updatedAt: 1,
      },
    ],
    ts: 1,
  };
}

suite.define(() => {
  it("filters grouped sessions from the toolbar without duplicate header controls", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const response = sessionsList();
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
      // The toolbar filters refine All; Mine intentionally excludes both foreign owners.
      await page
        .locator(".sidebar-navigation-scope")
        .getByRole("button", { name: "All", exact: true })
        .click();
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
      const beforeFilter = (await gateway.getRequests("sessions.list")).length;
      await chooseSidebarOwner(page, "owner:profile-ada");
      await closeSidebarMenu(page);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).slice(beforeFilter))
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              params: expect.objectContaining({ ownerId: "profile-ada" }),
            }),
          ]),
        );
      await expectBrowser(bobSection).toHaveCount(0);
      await expectBrowser(adaSection.getByText("Ada research", { exact: true })).toBeVisible();
      const summary = page.locator(".sidebar-session-filter-summary");
      const funnel = page.getByRole("button", { name: "Filter & sort", exact: true });
      await expectBrowser(summary).toBeVisible();
      await expectBrowser(summary).toContainText("Ada");
      await expectBrowser(summary).toHaveAccessibleName("Ada · Show all sessions");
      await expectBrowser(funnel).toHaveClass(/sidebar-session-sort--filtered/);
      await expectBrowser(header.locator(".sidebar-session-group-actions")).toHaveCount(0);

      const beforeClear = (await gateway.getRequests("sessions.list")).length;
      await summary.click();
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).slice(beforeClear).some((request) => {
            const params = request.params as { ownerId?: unknown; involvingMe?: unknown };
            return params.ownerId === undefined && params.involvingMe === undefined;
          }),
        )
        .toBe(true);
      await expectBrowser(bobSection).toBeVisible();
      await expectBrowser(summary).toHaveCount(0);
      await expectBrowser(funnel).not.toHaveClass(/sidebar-session-sort--filtered/);
      await expectBrowser(header.locator(".sidebar-session-group-actions")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
