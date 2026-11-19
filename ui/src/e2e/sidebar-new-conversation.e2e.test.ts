import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sidebarSession } from "./sidebar-contract.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar New session" });
suite.define(() => {
  it("keeps New session in the Sessions header, then opens the same agent from the mobile drawer", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
      async ({ page }) => {
        await installMockGateway(page, {
          assistantName: "Atlas",
          sessionKey: "agent:main:current",
          sessions: [
            sidebarSession("agent:main:current", "Launch planning", { updatedAt: 1791871200000 }),
            sidebarSession("agent:main:design", "Design review", { updatedAt: 1791871000000 }),
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        await page
          .locator(".sidebar-recent-session__name")
          .filter({ hasText: "Design review" })
          .waitFor();
        const sidebar = page.locator("openclaw-app-sidebar");
        const header = sidebar.locator(".sidebar-session-toolbar");
        const create = header.getByRole("link", { name: "New session", exact: true });
        await create.waitFor();
        expect(await sidebar.locator(".sidebar-rail .sidebar-new-session").count()).toBe(0);
        // Filter & sort, New session, then Collapse sidebar.
        const [filter, plus, collapse] = await Promise.all([
          header.locator(".sidebar-session-sort").boundingBox(),
          create.boundingBox(),
          header.getByRole("button", { name: "Collapse sidebar", exact: true }).boundingBox(),
        ]);
        expect(plus!.x).toBeGreaterThan(filter!.x + filter!.width);
        expect(plus!.x + plus!.width).toBeLessThan(collapse!.x);
        expect(await create.getAttribute("href")).toBe("/new?agent=main");
        await sidebar.locator('[data-navigation-view="online"]').click();
        await sidebar.locator(".sidebar-online").waitFor();
        expect(await sidebar.locator(".sidebar-new-session").count()).toBe(0);
        await sidebar.locator('[data-navigation-view="sessions"]').click();
        await create.waitFor();
        await header.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
        await page.locator(".shell--nav-collapsed").waitFor();
        expect(await create.isVisible()).toBe(false);
        expect(await page.locator(".shell-chrome-controls__new-thread").count()).toBe(0);
        await page.setViewportSize({ width: 390, height: 844 });
        // The closed drawer stays mounted for its slide animation.
        const nav = page.locator(".shell-nav");
        await expect.poll(() => nav.getAttribute("aria-hidden")).toBe("true");
        expect(await nav.getAttribute("inert")).not.toBeNull();
        expect(await nav.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe(
          "none",
        );
        await expect
          .poll(() => nav.evaluate((element) => element.getBoundingClientRect().right))
          .toBeLessThanOrEqual(0);
        await navigationDrawerToggle(page).click();
        await page.locator(".shell--nav-drawer-open").waitFor();
        await create.waitFor();
        await create.focus();
        await page.keyboard.press("Enter");
        await waitForControlUiRoute(page, { routeId: "new-session", search: "?agent=main" });
        await page.locator(".new-session-page__message").waitFor();
        expect(await page.locator(".shell--nav-drawer-open").count()).toBe(0);
      },
    );
  });
});
