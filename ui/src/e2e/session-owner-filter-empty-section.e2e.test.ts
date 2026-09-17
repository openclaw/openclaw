import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([
    { filter: "specific owner", hasMore: false, involvingMe: false },
    { filter: "specific owner", hasMore: true, involvingMe: false },
    { filter: "involving me", hasMore: false, involvingMe: true },
  ])(
    "hides empty Other under $filter and restores it when cleared (hasMore=$hasMore)",
    async ({ hasMore, involvingMe }) => {
      const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
      const page = await context.newPage();
      const owners = Array.from({ length: 8 }, (_, index) => ({
        type: "human" as const,
        id: `profile-${index}`,
        identity: { type: "profile" as const, id: `profile-${index}` },
        label: `Owner ${index + 1}`,
      }));
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

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:owner-0"));
        const filter = page.getByRole("button", { name: "Filter & sort" });
        const menu = page.locator(".sidebar-session-sort-menu");
        await filter.click();
        await menu
          .getByRole("group", { name: "Group by", exact: true })
          .getByRole("button", { name: "Person", exact: true })
          .click();
        const people = page.locator('[data-session-section^="person:"]');
        const other = page.locator('[data-session-section="ungrouped"]');
        await expectBrowser(people).toHaveCount(8);
        await expectBrowser(
          other.getByRole("button", { name: "Other", exact: true }),
        ).toBeVisible();
        await expectBrowser(other.locator("[data-session-key]")).toHaveCount(0);

        if (involvingMe) {
          // Participant membership is evaluated by the Gateway, not the renderer.
          await gateway.setMethodResponse("sessions.list", {
            ...allSessions,
            count: 1,
            sessions: allSessions.sessions.slice(0, 1),
          });
        }
        await menu.getByRole("button", { name: /^Owners:/ }).click();
        if (involvingMe) {
          await menu.getByRole("option", { name: "Involving me", exact: true }).click();
        } else {
          await menu.getByRole("option", { name: /^Specific owner/ }).click();
          await menu.locator('.sidebar-session-owner-picker [value="owner:profile-0"]').click();
        }
        await expectBrowser(people).toHaveCount(1);
        await expectBrowser(people).toContainText("Owner 1 session");
        await expect
          .poll(async () =>
            (await gateway.getRequests("sessions.list")).some((request) => {
              const params = request.params as
                | { ownerId?: string; involvingMe?: boolean }
                | undefined;
              return involvingMe ? params?.involvingMe === true : params?.ownerId === "profile-0";
            }),
          )
          .toBe(true);
        await captureUiProof(suite, page, `filtered-has-more-${hasMore}.png`);
        await expectBrowser(other).toHaveCount(0);

        const emptyGroups = menu.getByRole("button", { name: /^Hide empty groups:/ });
        await emptyGroups.click();
        await captureUiProof(suite, page, `empty-group-choice-${involvingMe}-${hasMore}.png`);
        await menu.getByRole("option", { name: "Never", exact: true }).click();
        await expectBrowser(other).toHaveCount(1);
        await expectBrowser(other.locator("[data-session-key]")).toHaveCount(0);
        await expectBrowser(people).toHaveCount(1);
        await emptyGroups.click();
        await menu.getByRole("option", { name: "When filtering", exact: true }).click();
        await expectBrowser(other).toHaveCount(0);

        // An owner filter must not hide matching rows that really belong in Other.
        await menu
          .getByRole("group", { name: "Group by", exact: true })
          .getByRole("button", { name: "Custom groups", exact: true })
          .click();
        await expectBrowser(other).toContainText("Owner 1 session");
        await menu
          .getByRole("group", { name: "Group by", exact: true })
          .getByRole("button", { name: "Person", exact: true })
          .click();
        await expectBrowser(other).toHaveCount(0);

        await gateway.setMethodResponse("sessions.list", allSessions);
        await menu.getByRole("button", { name: /^Owners:/ }).click();
        await menu.getByRole("option", { name: "All owners", exact: true }).click();
        await page.keyboard.press("Escape");
        await expectBrowser(people).toHaveCount(8);
        await expectBrowser(
          other.getByRole("button", { name: "Other", exact: true }),
        ).toBeVisible();
        await expectBrowser(other.locator("[data-session-key]")).toHaveCount(0);
      } finally {
        await context.close();
      }
    },
  );
  it("keeps empty-group choices inside the narrow-screen menu and remembers the choice", async () => {
    const context = await suite.browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      sessionGroups: ["Empty"],
      sessions: [sessionRow("agent:main:mobile", "Mobile session", 8)],
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:mobile"));
      const filter = page.getByRole("button", { name: "Filter & sort", exact: true });
      const openMenu = async () => {
        if (!(await filter.isVisible())) {
          await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
        }
        await filter.click();
      };
      await openMenu();
      const menu = page.locator(".sidebar-session-sort-menu");
      const choice = menu.getByRole("button", { name: /^Hide empty groups:/ });
      await choice.scrollIntoViewIfNeeded();
      await captureUiProof(suite, page, "empty-groups-mobile-root.png");
      await choice.click();
      await expectBrowser(
        menu.getByRole("option", { name: "When filtering", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      const bounds = await menu
        .getByRole("listbox", { name: "Hide empty groups", exact: true })
        .boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
      await captureUiProof(suite, page, "empty-groups-mobile-choices.png");
      await page.keyboard.press("Escape");
      await expectBrowser(menu).toBeVisible();
      await expectBrowser(choice).toBeFocused();
      await choice.click();
      await menu.getByRole("option", { name: "Always", exact: true }).click();
      await expectBrowser(page.locator('[data-session-section="category:Empty"]')).toHaveCount(0);
      await page.reload();
      await openMenu();
      await expectBrowser(choice).toHaveAccessibleName("Hide empty groups: Always");
      await choice.click();
      await menu.getByRole("option", { name: "Never", exact: true }).click();
      await page.keyboard.press("Escape");
      await expectBrowser(page.locator('[data-session-section="category:Empty"]')).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
