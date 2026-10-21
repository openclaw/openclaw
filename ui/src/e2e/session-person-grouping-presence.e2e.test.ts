import { expect as expectBrowser } from "playwright/test";
import { it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsList } from "./session-ownership-fixtures.test-support.ts";
import {
  openSidebarSortMenu,
  routeAvatarFixtures,
} from "./session-ownership-visuals.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI person-grouped session presence",
});

suite.define(() => {
  it("shows row owners only for live presence under person headers", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    await routeAvatarFixtures(page, [
      { id: "profile-ada", background: "#3f6f76", label: "A" },
      { id: "profile-bob", background: "#985b42", label: "B" },
      { id: "profile-morgan", background: "#66508c", label: "M" },
    ]);
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-self", name: "Self" }],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": sessionsList(undefined, true, { categories: false, actorAvatars: true }),
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
      await selectAllSidebarSessions(page);
      await page.getByText("Ada research", { exact: true }).first().waitFor();
      const menu = await openSidebarSortMenu(page);
      await chooseSidebarMenuOption(menu.page(), "Group by", "Person");
      await closeSidebarMenu(page);
      const adaSection = page.locator('[data-session-section="person:profile:profile-ada"]');
      const bobSection = page.locator('[data-session-section="person:profile:profile-bob"]');
      await expectBrowser(adaSection).toContainText("Ada research");
      await expectBrowser(bobSection).toContainText("Bob operations");

      await gateway.emitGatewayEvent("presence", {
        presence: [
          ["ada", "Ada", "ada"],
          ["morgan", "Morgan", "bob"],
        ].map(([id, name, session]) => ({
          instanceId: `${id}-browser`,
          mode: "webchat",
          reason: "connect",
          ts: Date.now(),
          user: {
            id: `profile-${id}`,
            identity: { type: "profile", id: `profile-${id}` },
            name,
            avatarUrl: `/api/users/profile-${id}/avatar?v=1`,
          },
          watchedSessions: [`agent:main:${session}`],
        })),
      });
      await expectBrowser(
        adaSection.locator(".session-owner-chip:not(.session-owner-chip--away)"),
      ).toHaveCount(1);
      await expectBrowser(bobSection.locator('[data-viewer-id="profile-morgan"]')).toHaveCount(1);

      await expectBrowser(bobSection.locator("openclaw-session-owner-chip")).toHaveCount(0);
      const adaHeader = adaSection.locator(".sidebar-recent-sessions__head");
      await adaHeader.hover();

      await page.mouse.move(0, 0);

      const textColor = await page.locator(".sidebar-sessions").evaluate((sidebar) => {
        const probe = document.createElement("span");
        probe.style.color = getComputedStyle(sidebar).getPropertyValue("--text");
        sidebar.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await adaHeader.hover();
      await expectBrowser
        .poll(() =>
          adaHeader
            .locator(".sidebar-recent-sessions__label-text")
            .evaluate((label) => getComputedStyle(label).color),
        )
        .toBe(textColor);
      await expectBrowser(adaSection.locator(".sidebar-session-group-presence")).toHaveCount(1);
      await expectBrowser(bobSection.locator(".sidebar-session-group-presence")).toHaveCount(0);

      await adaSection.locator("[data-person-card]").hover();
      const adaCard = page.getByRole("dialog", { name: "Activity for Ada" });
      await expectBrowser(adaCard).toBeVisible();

      await page.mouse.move(0, 0);
      await adaCard.waitFor({ state: "detached" });
      await bobSection.locator("[data-person-card]").hover();
      const bobCard = page.getByRole("dialog", { name: "Activity for Bob" });
      await expectBrowser(bobCard).toBeVisible();
      await expectBrowser(bobCard).toContainText("Offline");
      await expectBrowser(bobCard.locator("dl")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
