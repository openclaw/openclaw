import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { nativePane } from "../test-helpers/chat-layout-menu.ts";

/** Pass a pane locator when more than one chat is presented. */
export async function openChatDetails(page: Page | Locator): Promise<Locator> {
  const pane = nativePane(page);
  await waitForLayoutSettled(
    pane.page(),
    "openclaw-chat-pane :is(.agent-chat__header--mobile, .sidebar-region__header, [data-region-header])",
  );
  const details = pane
    .getByRole("dialog", { name: "Details", exact: true })
    .or(pane.getByRole("complementary", { name: "Details", exact: true }));
  if (!(await details.isVisible())) {
    const trigger = pane.getByRole("button", { name: "Details", exact: true });
    // Role lookup excludes aria-hidden cached panes; CSS visibility alone includes them.
    const sessionMenu = pane
      .getByRole("button")
      .and(pane.locator(".chat-header-session-menu__trigger"));
    // Startup can replace the offline button with the session menu during actionability checks.
    await trigger.or(sessionMenu).filter({ visible: true }).first().click();
    const menuItem = pane.getByRole("menuitem", { name: "Session details", exact: true });
    await details.or(menuItem).filter({ visible: true }).first().waitFor();
    if (await menuItem.isVisible()) {
      await menuItem.click();
    }
  }
  await details.waitFor();
  return details;
}

/** Dismiss through the visible control in both desktop and mobile presentations. */
export async function closeChatDetails(page: Page | Locator): Promise<void> {
  const pane = nativePane(page);
  await waitForLayoutSettled(
    pane.page(),
    "openclaw-chat-pane :is(.agent-chat__header--mobile, .sidebar-region__header, [data-region-header])",
  );
  const details = pane
    .getByRole("dialog", { name: "Details", exact: true })
    .or(pane.getByRole("complementary", { name: "Details", exact: true }));
  await details.waitFor();
  const trigger = pane.getByRole("button", { name: "Details", exact: true });
  const nativeClose = pane
    .locator(".chat-mobile-host__header")
    .getByRole("button", { name: "Close", exact: true });
  if (await nativeClose.isVisible()) {
    await nativeClose.click();
  } else if (await trigger.isVisible()) {
    await trigger.click();
  } else {
    await details.getByRole("button", { name: "Close details", exact: true }).click();
  }
  await details.waitFor({ state: "hidden" });
}

export async function openDetailsPullRequests(page: Page | Locator): Promise<Locator> {
  const details = await openChatDetails(page);
  const session = details.locator(".chat-details-session");
  const pullRequests = session.locator('[data-details-group="pull-requests"]');
  if ((await pullRequests.getAttribute("open")) === null) {
    await pullRequests.locator(":scope > summary").click();
  }
  await expect.poll(() => pullRequests.getAttribute("open")).not.toBeNull();
  return pullRequests;
}

/** Open the saved plan through the current desktop disclosure or mobile Details page. */
export async function openChatTaskProgress(page: Page | Locator): Promise<Locator> {
  const details = await openChatDetails(page);
  const root = details.locator(".chat-details-mobile-root").filter({ visible: true });
  const mobilePage = details
    .locator('.chat-mobile-details-page[data-details-page="task-progress"]')
    .filter({ visible: true });
  if (await details.locator(".chat-mobile-host__details").count()) {
    await expect
      .poll(async () => (await root.isVisible()) || (await mobilePage.isVisible()))
      .toBe(true);
  }
  if (await root.isVisible()) {
    await root.locator('[data-details-destination="task-progress"]').click();
  }
  const progress = details
    .locator('[data-progress-card-placement="details"]')
    .or(details.locator('.chat-mobile-details-page[data-details-page="task-progress"]'))
    .filter({ visible: true });
  await progress.waitFor();
  return progress;
}
