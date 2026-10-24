import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForMobileSidebarDrawerOpen,
} from "./session-management.test-support.ts";
import { sessionPerson } from "./session-ownership-fixtures.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";
import {
  chooseSidebarOwner,
  chooseSidebarMenuOption,
  closeSidebarMenu,
  openSidebarMenu,
  settleSidebarMenuMotion,
} from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([
    { filter: "specific owner", hasMore: false, involvingMe: false },
    { filter: "specific owner", hasMore: true, involvingMe: false },
    { filter: "involving me", hasMore: false, involvingMe: true },
  ])(
    "hides empty Other under $filter and restores it when cleared (hasMore=$hasMore)",
    ({ hasMore, involvingMe }) =>
      suite.withPage({ viewport: { height: 800, width: 1200 } }, async ({ page }) => {
        const owners = Array.from({ length: 8 }, (_, index) =>
          sessionPerson(`profile-${index}`, `Owner ${index + 1}`),
        );
        const allSessions = {
          ...sessionsListResponse(
            owners.map((actor, index) => ({
              ...sessionRow(`agent:main:owner-${index}`, `Owner ${index + 1} session`, 8 - index),
              owner: { actor },
            })),
            { hasMore, nextOffset: hasMore ? 8 : null },
          ),
          owners,
        };
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:owner-0",
          presenceUsers: [{ self: true, id: "profile-0", name: "Owner 1" }],
          methodResponses: { "sessions.list": allSessions },
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:owner-0"));
        await selectAllSidebarSessions(page);
        const menu = await openSidebarMenu(page);
        await chooseSidebarMenuOption(menu.page(), "Group by", "Person");
        await chooseSidebarMenuOption(page, "Status", "All");
        const people = page.locator('[data-session-section^="person:"]');
        const other = page.locator('[data-session-section="ungrouped"]');
        const otherTitle = other.getByRole("button", { name: "Other", exact: true });
        await expectBrowser(people).toHaveCount(8);
        await expectBrowser(otherTitle).toBeVisible();
        await expectBrowser(other.locator("[data-session-key]")).toHaveCount(0);

        if (involvingMe) {
          // Participant membership is evaluated by the Gateway, not the renderer.
          await gateway.setMethodResponse("sessions.list", {
            ...allSessions,
            count: 1,
            sessions: allSessions.sessions.slice(0, 1),
          });
        }
        await openSidebarMenu(page);
        await chooseSidebarOwner(page, involvingMe ? "involving-me" : "owner:profile-0");
        await expectBrowser(people).toHaveCount(1);
        await expectBrowser(people).toContainText("Owner 1 session");
        await gateway.waitForRequest("sessions.list", {
          match: involvingMe ? { involvingMe: true } : { ownerId: "profile-0" },
        });
        await expectBrowser(other).toHaveCount(0);

        await openSidebarMenu(page);
        await chooseSidebarMenuOption(page, "Hide empty groups", "Never");
        await expectBrowser(other).toHaveCount(1);
        await expectBrowser(other.locator("[data-session-key]")).toHaveCount(0);
        await expectBrowser(people).toHaveCount(1);
        await chooseSidebarMenuOption(page, "Hide empty groups", "When filtering");
        await expectBrowser(other).toHaveCount(0);

        // An owner filter must not hide matching rows that really belong in Other.
        await chooseSidebarMenuOption(menu.page(), "Group by", "Custom groups");
        await expectBrowser(other).toContainText("Owner 1 session");
        await chooseSidebarMenuOption(menu.page(), "Group by", "Person");
        await expectBrowser(other).toHaveCount(0);

        await gateway.setMethodResponse("sessions.list", allSessions);
        await openSidebarMenu(page);
        await chooseSidebarOwner(page, "all");
        await closeSidebarMenu(page);
        await expectBrowser(people).toHaveCount(8);
        await expectBrowser(otherTitle).toBeVisible();
        await expectBrowser(other.locator("[data-session-key]")).toHaveCount(0);
      }),
  );
  it.each([
    { name: "desktop", width: 1200, height: 800 },
    { name: "mobile", width: 390, height: 844 },
  ])("applies status-only empty-group filtering on $name", ({ name, width, height }) =>
    suite.withPage(
      { viewport: { width, height }, hasTouch: name === "mobile" },
      async ({ page }) => {
        const owners = [sessionPerson("profile-0", "Taylor"), sessionPerson("profile-1", "Morgan")];
        const sessions = [
          sessionRow("agent:main:planning", "Plan next release", 30, { category: "Planning" }),
          sessionRow("agent:main:completed", "Release checklist", 20, {
            category: "Completed work",
            archived: true,
          }),
          sessionRow("agent:main:later", "Follow-up tomorrow", 10, {
            category: "Later",
            snoozedUntil: 4_000_000_000_000,
          }),
        ];
        await installMockGateway(page, {
          sessionGroups: ["Planning", "Completed work", "Later", "Empty group"],
          presenceUsers: [{ self: true, id: "profile-0", name: "Taylor" }],
          sessions,
          methodResponses: { "sessions.list": { ...sessionsListResponse(sessions), owners } },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        if (name === "mobile") {
          await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
          await waitForMobileSidebarDrawerOpen(page);
        }
        await selectAllSidebarSessions(page);
        const group = (title: string) => page.locator(`[data-session-section="category:${title}"]`);
        const menu = await openSidebarMenu(page);
        await chooseSidebarMenuOption(page, "Status", "All");
        await closeSidebarMenu(page);
        await expectBrowser(group("Planning")).toContainText("Plan next release");
        await expectBrowser(group("Completed work")).toContainText("Release checklist");
        await expectBrowser(group("Later")).toContainText("Follow-up tomorrow");
        await expectBrowser(group("Empty group")).toBeVisible();

        await openSidebarMenu(page);
        await chooseSidebarMenuOption(page, "Status", "Active");
        await closeSidebarMenu(page);
        await expectBrowser(group("Planning")).toBeVisible();
        await captureUiProof(suite, page, `status-active-${name}.png`);
        await expectBrowser(group("Completed work")).toHaveCount(0);
        await expectBrowser(group("Later")).toHaveCount(0);
        await expectBrowser(group("Empty group")).toHaveCount(0);
        // A collapsed, populated group remains a destination through filter changes.
        await group("Planning").locator(".sidebar-session-group-toggle").click();
        await expectBrowser(
          group("Planning").locator(".sidebar-session-group-toggle"),
        ).toHaveAttribute("aria-expanded", "false");

        await openSidebarMenu(page);
        await chooseSidebarMenuOption(page, "Hide empty groups", "Never");
        await closeSidebarMenu(page);
        await expectBrowser(group("Completed work")).toBeVisible();
        await expectBrowser(group("Completed work").locator("[data-session-key]")).toHaveCount(0);
        await openSidebarMenu(page);
        await chooseSidebarMenuOption(page, "Hide empty groups", "When filtering");
        await chooseSidebarMenuOption(page, "Status", "Archived");
        await closeSidebarMenu(page);
        await expectBrowser(group("Completed work")).toContainText("Release checklist");
        await expectBrowser(group("Planning")).toHaveCount(0);
        await expectBrowser(group("Later")).toHaveCount(0);
        await openSidebarMenu(page);
        await chooseSidebarMenuOption(page, "Status", "Snoozed");
        await closeSidebarMenu(page);
        await expectBrowser(group("Later")).toContainText("Follow-up tomorrow");
        await expectBrowser(group("Completed work")).toHaveCount(0);
        await openSidebarMenu(page);
        await chooseSidebarMenuOption(page, "Status", "All");
        await closeSidebarMenu(page);
        await expectBrowser(group("Empty group")).toBeVisible();
        await expectBrowser(group("Completed work")).toContainText("Release checklist");
        await expectBrowser(
          group("Planning").locator(".sidebar-session-group-toggle"),
        ).toHaveAttribute("aria-expanded", "false");
        await openSidebarMenu(page);
        await expectBrowser(
          menu.getByRole("button", { name: "Hide empty groups: When filtering", exact: true }),
        ).toBeVisible();
      },
    ),
  );

  it("keeps empty-group choices inside the narrow-screen menu and remembers the choice", () =>
    suite.withPage({ viewport: { width: 390, height: 844 }, hasTouch: true }, async ({ page }) => {
      await installMockGateway(page, {
        sessionGroups: ["Empty"],
        sessions: [sessionRow("agent:main:mobile", "Mobile session", 8)],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:mobile"));
      const filter = page.getByRole("button", { name: "Filter & sort", exact: true });
      const openMenu = async () => {
        if (!(await filter.isVisible())) {
          await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
        }
        return openSidebarMenu(page);
      };
      const menu = await openMenu();
      const choice = menu.locator("#sidebar-sessions-empty");
      await choice.scrollIntoViewIfNeeded();
      await choice.click();
      await expectBrowser(
        menu.getByRole("option", { name: "When filtering", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      const choices = menu.getByRole("listbox", { name: "Hide empty groups", exact: true });
      await settleSidebarMenuMotion(choices);
      const bounds = await choices.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
      await menu.getByRole("option", { name: "Always", exact: true }).click();
      await expectBrowser(page.locator('[data-session-section="category:Empty"]')).toHaveCount(0);
      await page.reload();
      await openMenu();
      await expectBrowser(choice).toHaveAccessibleName("Hide empty groups: Always");
      await chooseSidebarMenuOption(page, "Hide empty groups", "Never");
      await closeSidebarMenu(page);
      await expectBrowser(page.locator('[data-session-section="category:Empty"]')).toBeVisible();
    }));
});
