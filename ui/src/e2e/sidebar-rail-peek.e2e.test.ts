import { expect, it } from "vitest";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("peeks a section's sidebar from the closed rail without leaving the page", async () => {
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 1280, height: 800 } },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new`);
        const sidebar = page.locator("openclaw-app-sidebar .sidebar-shell");
        const peek = page.locator("openclaw-app-sidebar[data-peek]");
        const collapsed = page.locator(".shell--nav-collapsed");
        await sidebar.waitFor({ state: "visible" });
        await page
          .locator("openclaw-app-sidebar")
          .getByRole("button", { name: "Collapse sidebar", exact: true })
          .click();
        await sidebar.waitFor({ state: "hidden" });
        const contentLeft = () =>
          page.locator("main.content").evaluate((main) => main.getBoundingClientRect().left);
        const left = await contentLeft();

        const people = page.locator('.sidebar-rail [data-navigation-view="online"]');
        await people.hover();
        await page.locator("openclaw-app-sidebar .sidebar-online").waitFor({ state: "visible" });
        expect(await peek.count()).toBe(1);
        expect(await collapsed.count()).toBe(1);
        expect(new URL(page.url()).pathname).toBe("/new");
        expect(await contentLeft()).toBe(left);

        // Leaving the sidebar hides the peek.
        await page.mouse.move(900, 400);
        await sidebar.waitFor({ state: "hidden" });
        expect(await peek.count()).toBe(0);

        // A link in the peek navigates and closes it; the sidebar stays closed.
        await people.hover();
        await page.locator("openclaw-app-sidebar .sidebar-online__overview a").click();
        await waitForControlUiRoute(page, { routeId: "activity" });
        await sidebar.waitFor({ state: "hidden" });
        expect(await collapsed.count()).toBe(1);

        // Choosing the item while peeking opens its sidebar for good.
        await page.mouse.move(900, 400);
        await people.hover();
        await peek.waitFor({ state: "attached" });
        await people.click();
        await expect.poll(() => collapsed.count()).toBe(0);
        expect(await peek.count()).toBe(0);
        await page.mouse.move(900, 400);
        expect(await page.locator("openclaw-app-sidebar .sidebar-online").isVisible()).toBe(true);
      },
    );
  });
});
