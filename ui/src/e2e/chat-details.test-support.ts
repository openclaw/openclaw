import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { nativePane } from "../test-helpers/chat-layout-menu.ts";
import { recordControlUiE2eFailureFacts } from "../test-helpers/control-ui-e2e-diagnostics.ts";

function visibleDetails(pane: Locator): Locator {
  return pane
    .locator(".chat-details:not(.chat-mobile-host .chat-details)")
    .or(pane.locator(".chat-mobile-host:has(.chat-mobile-host__details:not([hidden]))"))
    .filter({ visible: true });
}

/** Pass a pane locator when more than one chat is presented. */
export async function openChatDetails(page: Page | Locator): Promise<Locator> {
  const pane = nativePane(page);
  const headers = ".agent-chat__header--mobile, .sidebar-region__header, [data-region-header]";
  await pane.locator(headers).filter({ visible: true }).first().waitFor();
  await waitForLayoutSettled(
    pane.page(),
    "openclaw-chat-pane :is(.agent-chat__header--mobile, .sidebar-region__header, [data-region-header])",
  );
  const details = visibleDetails(pane);
  if (!(await details.isVisible())) {
    // Both native entries survive reconnect; mobile opens Details from the title.
    const entry = pane
      .locator(".mobile-header__title")
      .or(
        pane
          .getByRole("button", { name: "Details", exact: true })
          .and(pane.locator(".chat-details-toggle")),
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
  const pane = nativePane(page);
  const details = visibleDetails(pane);
  await details.waitFor();
  const mobileClose = details.locator(".chat-mobile-host__header").getByRole("button", {
    name: "Close",
    exact: true,
  });
  if (await mobileClose.isVisible()) {
    await mobileClose.click();
  } else {
    await pane
      .getByRole("button", { name: "Details", exact: true })
      .and(pane.locator(".chat-details-toggle"))
      .click();
  }
  await details.waitFor({ state: "hidden" });
}

async function openMobileDetailsRoot(page: Page | Locator, details: Locator): Promise<Locator> {
  const root = details.locator('.chat-mobile-details-page[data-details-page="root"]');
  const back = details.locator(".chat-mobile-host__header").getByRole("button", {
    name: "Back",
    exact: true,
  });
  await details.locator(".chat-mobile-details-page").filter({ visible: true }).first().waitFor();
  while (!(await root.isVisible())) {
    if (await back.isVisible()) {
      await back.click();
    } else {
      // Direct activity-pill destinations have no Back ancestor.
      await closeChatDetails(page);
      await openChatDetails(page);
      await root.waitFor();
      break;
    }
  }
  return root;
}

/** Return the native PR collection: a desktop disclosure or the mobile root group. */
export async function openDetailsPullRequests(page: Page | Locator): Promise<Locator> {
  const details = await openChatDetails(page);
  if (await details.locator(".chat-mobile-host__details").count()) {
    const root = await openMobileDetailsRoot(page, details);
    const group = root.locator('[data-details-group="pull-requests"]');
    await group.waitFor();
    return group;
  }
  const pullRequests = details.locator(
    '.chat-details-session [data-details-group="pull-requests"]',
  );
  if ((await pullRequests.getAttribute("open")) === null) {
    await pullRequests.locator(":scope > summary").click();
  }
  await expect.poll(() => pullRequests.getAttribute("open")).not.toBeNull();
  return pullRequests;
}

/** Open the actual People list through its desktop disclosure or mobile Details page. */
export async function openChatDetailsPeople(page: Page | Locator): Promise<Locator> {
  const details = await openChatDetails(page);
  if (await details.locator(".chat-mobile-host__details").count()) {
    const people = details.locator('.chat-mobile-details-page[data-details-page="people"]');
    if (!(await people.isVisible())) {
      const root = await openMobileDetailsRoot(page, details);
      await root.locator('[data-details-destination="people"]').click();
    }
    await people.waitFor();
    return people;
  }
  const people = details.locator('[data-details-group="people"]');
  const summary = people.locator(":scope > summary");
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    await summary.click();
  }
  await expect.poll(() => summary.getAttribute("aria-expanded")).toBe("true");
  await people.locator(".chat-details-people").waitFor();
  return people;
}

/** Open publication review without invoking the publication action. */
export async function openChatPublication(page: Page | Locator): Promise<Locator> {
  const details = await openChatDetails(page);
  if (await details.locator(".chat-mobile-host__details").count()) {
    const group = await openDetailsPullRequests(page);
    await group.locator('[data-details-destination="publication"]').click();
    const review = details.locator('.chat-mobile-details-page[data-details-page="publication"]');
    await review.waitFor();
    return review;
  }
  const environment = details.locator('[data-details-group="environment"]');
  const summary = environment.locator(":scope > summary");
  // Native open stays set during closing motion and is restored after initial layout.
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    await summary.click();
  }
  await expect.poll(() => summary.getAttribute("aria-expanded")).toBe("true");
  const branch = environment.locator(".chat-environment__branch");
  await branch.waitFor();
  await branch.locator(".chat-pr__publication-actions").waitFor();
  const actions = branch.locator(".chat-pr__actions-trigger");
  if (await actions.count()) {
    const observation = await environment.evaluateHandle((root) => {
      const initialTrigger = root.querySelector(".chat-pr__actions-trigger");
      const initialMenu = root.querySelector(".chat-pr-branch-menu");
      const read = () => {
        const trigger = root.querySelector(".chat-pr__actions-trigger");
        const menu = root.querySelector(".chat-pr-branch-menu");
        return {
          environmentConnected: root.isConnected,
          triggerConnected: trigger?.isConnected ?? false,
          triggerReplaced: trigger !== initialTrigger,
          triggerExpanded: trigger?.getAttribute("aria-expanded") === "true",
          triggerInert: Boolean(trigger?.closest("[inert]")),
          menuConnected: menu?.isConnected ?? false,
          menuReplaced: menu !== initialMenu,
          menuOpen: menu?.matches(":popover-open") ?? false,
          menuInert: Boolean(menu?.closest("[inert]")),
          menuState: menu?.getAttribute("data-state") ?? null,
          menuPhase: menu?.getAttribute("data-phase") ?? null,
        };
      };
      type Snapshot = ReturnType<typeof read>;
      const before = read();
      const events: Array<Snapshot & { type: string; defaultPrevented: boolean }> = [];
      const types = [
        "pointerdown",
        "click",
        "beforetoggle",
        "toggle",
        "overlay-show",
        "overlay-after-show",
        "overlay-hide",
        "overlay-after-hide",
      ];
      const record = (event: Event) => {
        const target = event.target;
        if (!(target instanceof Element) || !root.contains(target) || events.length >= 16) {
          return;
        }
        if (
          !target.matches(".chat-pr-branch-menu") &&
          !target.closest(".chat-pr__actions-trigger")
        ) {
          return;
        }
        const entry = { ...read(), type: event.type, defaultPrevented: event.defaultPrevented };
        events.push(entry);
        // Capture the final veto after all event listeners have run.
        queueMicrotask(() => {
          entry.defaultPrevented = event.defaultPrevented;
        });
      };
      for (const type of types) {
        root.ownerDocument.addEventListener(type, record, true);
      }
      return {
        read: () => ({ before, events, after: read() }),
        dispose: () => {
          for (const type of types) {
            root.ownerDocument.removeEventListener(type, record, true);
          }
        },
      };
    });
    try {
      if ((await actions.getAttribute("aria-expanded")) !== "true") {
        await actions.click();
      }
      await environment.locator(".chat-pr-branch-menu").waitFor();
    } catch (error) {
      recordControlUiE2eFailureFacts(environment.page(), {
        publicationMenu: await observation.evaluate((probe) => probe.read()),
      });
      throw error;
    } finally {
      try {
        await observation.evaluate((probe) => probe.dispose());
      } finally {
        await observation.dispose();
      }
    }
  }
  return environment;
}

/** Navigate the desktop PR action menu while retaining the selected row's identity. */
export async function openDesktopPullRequestPage(
  row: Locator,
  destination: "checks" | "monitoring",
  input: "pointer" | "keyboard" = "pointer",
): Promise<Locator> {
  const activate = (control: Locator) =>
    input === "keyboard" ? control.press("Enter") : control.click();
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

/** Open the saved plan through the current desktop disclosure or mobile Details page. */
export async function openChatTaskProgress(page: Page | Locator): Promise<Locator> {
  const details = await openChatDetails(page);
  const mobilePage = details
    .locator('.chat-mobile-details-page[data-details-page="task-progress"]')
    .filter({ visible: true });
  if (await details.locator(".chat-mobile-host__details").count()) {
    if (!(await mobilePage.isVisible())) {
      const root = await openMobileDetailsRoot(page, details);
      await root.locator('[data-details-destination="task-progress"]').click();
    }
  }
  const progress = details
    .locator('[data-progress-card-placement="details"]')
    .or(details.locator('.chat-mobile-details-page[data-details-page="task-progress"]'))
    .filter({ visible: true });
  await progress.waitFor();
  return progress;
}
