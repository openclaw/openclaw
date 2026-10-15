import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";

/** Pass a pane locator when more than one chat is presented. */
export async function openChatDetails(page: Page | Locator): Promise<Locator> {
  const details = page
    .getByRole("dialog", { name: "Details", exact: true })
    .or(page.getByRole("complementary", { name: "Details", exact: true }));
  if (!(await details.isVisible())) {
    const trigger = page.getByRole("button", { name: "Details", exact: true });
    await trigger
      .or(page.getByRole("button", { name: "Panels", exact: true }))
      .first()
      .waitFor();
    if (await trigger.isVisible()) {
      await trigger.click();
    } else {
      await selectChatLayoutAction(page, "Details");
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
