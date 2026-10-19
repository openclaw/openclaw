import type { Locator, Page } from "playwright";
import { expect } from "vitest";

function visibleDetails(page: Page | Locator): Locator {
  return page
    .locator(".chat-details:not(.chat-mobile-host .chat-details)")
    .or(page.locator(".chat-mobile-host:has(.chat-mobile-host__details:not([hidden]))"))
    .filter({ visible: true });
}

/** Pass a pane locator when more than one chat is presented. */
export async function openChatDetails(page: Page | Locator): Promise<Locator> {
  const details = visibleDetails(page);
  if (!(await details.isVisible())) {
    // Both native entries survive reconnect; mobile opens Details from the title.
    const entry = page
      .locator(".mobile-header__title")
      .or(
        page
          .getByRole("button", { name: "Details", exact: true })
          .and(page.locator(".chat-details-toggle")),
      )
      .filter({ visible: true })
      .first();
    await entry.click();
  }
  await details.waitFor();
  return details;
}

/** Dismiss through the visible native control on either platform. */
export async function closeChatDetails(page: Page | Locator): Promise<void> {
  const details = visibleDetails(page);
  await details.waitFor();
  const mobileClose = details.locator(".chat-mobile-host__header").getByRole("button", {
    name: "Close",
    exact: true,
  });
  if (await mobileClose.isVisible()) {
    await mobileClose.click();
  } else {
    await page
      .getByRole("button", { name: "Details", exact: true })
      .and(page.locator(".chat-details-toggle"))
      .click();
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
