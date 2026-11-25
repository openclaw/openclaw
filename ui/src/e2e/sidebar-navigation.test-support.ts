import type { Page } from "playwright";
import { expect } from "vitest";
import { controlUiSessionPath, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { openProgressHomeDock } from "./session-progress-home.test-support.ts";

/** Home can focus its existing page directly or first open the dock on another conversation. */
export async function openHomeFullPage(page: Page, agentId = "main"): Promise<void> {
  const pathname = controlUiSessionPath("agent:" + agentId + ":main");
  const pageAction = page.locator(".assistant-panel").getByRole("button", {
    name: "Open Home full page",
    exact: true,
  });
  if (!(await pageAction.isVisible())) {
    await openProgressHomeDock(page, { waitForSession: false });
  }
  await expect
    .poll(async () => new URL(page.url()).pathname === pathname || (await pageAction.isVisible()))
    .toBe(true);
  // Chip navigation may reach Home before the dock receives its route properties.
  if (new URL(page.url()).pathname === pathname) {
    await waitForControlUiRoute(page, { pathname, routeId: "chat" });
    return;
  }
  if (await pageAction.isVisible()) {
    await pageAction.click();
  }
  await waitForControlUiRoute(page, { pathname, routeId: "chat" });
}

/** Cross-owner scenarios choose All owners explicitly instead of broadening the default. */
export async function selectAllSidebarSessions(page: Page): Promise<void> {
  await page.locator("#sidebar-session-owner-title").click();
  await page.locator('.sidebar-session-owner-filter [role="option"][data-value="all"]').click();
}
