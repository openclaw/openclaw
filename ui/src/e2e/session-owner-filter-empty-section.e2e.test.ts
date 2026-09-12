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
        await menu.locator('[value="grouping:person"]').click();
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
        await filter.click();
        if (involvingMe) {
          await menu.locator('[value="involving-me"]').click();
        } else {
          await menu.getByRole("menuitem", { name: /Specific owner/ }).hover();
          await menu.locator('[slot="submenu"][value="owner:profile-0"]').click();
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

        // An owner filter must not hide matching rows that really belong in Other.
        await filter.click();
        await menu.locator('[value="grouping:category"]').click();
        await expectBrowser(other).toContainText("Owner 1 session");
        await filter.click();
        await menu.locator('[value="grouping:person"]').click();
        await expectBrowser(other).toHaveCount(0);

        await gateway.setMethodResponse("sessions.list", allSessions);
        await filter.click();
        await menu.locator('[value="owner:"]').click();
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
});
