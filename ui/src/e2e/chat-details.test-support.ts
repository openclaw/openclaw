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

/** Open the current compact branch menu or retained publication history. */
export async function openChatPublication(page: Page | Locator): Promise<Locator> {
  const group = await openDetailsPullRequests(page);
  await group.locator(".chat-pr, .chat-pr__publication-history").first().waitFor();
  const actions = group.locator('.chat-pr[data-state="branch"] .chat-pr__actions-trigger');
  if (await actions.count()) {
    if ((await actions.getAttribute("aria-expanded")) !== "true") {
      await actions.click();
    }
    await group.locator(".chat-pr-branch-menu").waitFor();
  } else {
    const history = group.locator(".chat-pr__publication-history");
    if ((await history.count()) > 0 && (await history.getAttribute("open")) === null) {
      await history.locator(":scope > summary").click();
    }
  }
  return group;
}

/** Preserve the caller's input mode through the compact menu pages. */
export async function openDesktopPullRequestPage(
  row: Locator,
  destination: "checks" | "monitoring",
  input: "pointer" | "keyboard" | "touch" = "pointer",
): Promise<Locator> {
  const activate = (control: Locator) =>
    input === "keyboard"
      ? control.press("Enter")
      : input === "touch"
        ? control.tap()
        : control.click();
  const trigger = row.locator(".chat-pr__actions-trigger");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await activate(trigger);
  }
  const menu = row.locator(".chat-pr-menu");
  const back = menu.locator('[data-value="back"]');
  if (await back.isVisible()) {
    await activate(back);
  }
  await activate(menu.locator(`[data-value="${destination}"]`));
  await menu.locator(".chat-pr-menu__page:visible").waitFor();
  return menu;
}

/** The lower prefix retains the inline Details progress disclosure. */
export async function openChatTaskProgress(page: Page | Locator): Promise<Locator> {
  const details = await openChatDetails(page);
  const progress = details.locator('[data-progress-card-placement="details"]');
  await progress.waitFor();
  return progress;
}
