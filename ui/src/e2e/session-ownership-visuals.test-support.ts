import type { Page } from "playwright";
import { expect } from "vitest";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { openSidebarMenu } from "./sidebar-session-menu.test-support.ts";

type AvatarFixture = { id: string; background: string; label: string };

export async function routeAvatarFixtures(page: Page, fixtures: readonly AvatarFixture[]) {
  await Promise.all(
    fixtures.map(({ id, background, label }) =>
      page.route(`**/api/users/${id}/avatar*`, (route) =>
        route.fulfill({
          // Static input assets must not depend on browser screenshot availability.
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="${background}"/><text x="32" y="32" text-anchor="middle" dominant-baseline="central" fill="white" style="font:700 26px system-ui">${label}</text></svg>`,
          contentType: "image/svg+xml",
          status: 200,
        }),
      ),
    ),
  );
}

export async function openSidebarSortMenu(page: Page) {
  const filterAndSort = page.getByRole("button", { name: /^Filter & sort · /, exact: true });
  await expect.poll(() => filterAndSort.count(), { timeout: 2_000 }).toBe(1);
  const menu = await openSidebarMenu(page);
  await waitForControlUiProofSurface(menu.locator(".sidebar-session-filter-panel"), [
    menu.getByRole("radio").first(),
  ]);
  return menu;
}
