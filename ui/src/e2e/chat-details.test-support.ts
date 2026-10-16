import type { Locator, Page } from "playwright";
import { expect } from "vitest";

/** Pass a pane locator when more than one chat is presented. */
export async function openChatDetails(page: Page | Locator): Promise<Locator> {
  const details = page
    .getByRole("dialog", { name: "Details", exact: true })
    .or(page.getByRole("complementary", { name: "Details", exact: true }));
  if (!(await details.isVisible())) {
    const trigger = page.getByRole("button", { name: "Details", exact: true });
    // Role lookup excludes aria-hidden cached panes; CSS visibility alone includes them.
    const sessionMenu = page
      .getByRole("button")
      .and(page.locator(".chat-header-session-menu__trigger"));
    // Startup can replace the offline button with the session menu during actionability checks.
    await trigger.or(sessionMenu).filter({ visible: true }).first().click();
    const menuItem = page.getByRole("menuitem", { name: "Session details", exact: true });
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
  const details = page
    .getByRole("dialog", { name: "Details", exact: true })
    .or(page.getByRole("complementary", { name: "Details", exact: true }));
  await details.waitFor();
  const trigger = page.getByRole("button", { name: "Details", exact: true });
  if (await trigger.isVisible()) {
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
