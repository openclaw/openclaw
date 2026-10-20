import { afterEach, expect, it } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { PRESENTATION_CHANGED_EVENT } from "../../../lib/presentation.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import "../../../styles.css";
import "../../../styles/chat/layout.css";
import "../../../styles/chat/split-view.css";
import { mountChatPaneHeader } from "./chat-pane-header.test-support.ts";

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

it("opens help on its own retained header and retires native overlays when presentation ends", async () => {
  const { page, userEvent } = await import("vitest/browser");
  await i18n.setLocale("en");
  const branches = [
    { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
    { leafEntryId: "other", headline: "Earlier idea", messageCount: 2, active: false },
  ];
  const first = mountChatPaneHeader(containers, { branches });
  await waitForSolid(() =>
    expect(first.container.querySelector(".chat-pane__branches-menu")).not.toBeNull(),
  );
  // Cached chats can retain headers with the same pane slot identity in one document.
  first.container.hidden = true;
  first.container.inert = true;

  const owner = new EventTarget();
  let presented = true;
  const second = mountChatPaneHeader(containers, {
    branches,
    presented: { owner, isPresented: () => presented },
  });
  await waitForSolid(() =>
    expect(second.container.querySelector(".chat-pane__branches-menu")).not.toBeNull(),
  );
  const menu = second.container.querySelector<HTMLElement>(".chat-pane__branches-menu")!;
  const trigger = menu.querySelector<HTMLButtonElement>(".chat-pane__branches-trigger")!;
  const menuSurface = menu.querySelector<HTMLElement>('[role="menu"]')!;

  await page.elementLocator(trigger).click();
  await expect.element(page.elementLocator(menuSurface)).toBeVisible();
  const info = menu.querySelector<HTMLButtonElement>(".chat-pane__versions-info")!;
  const help = menu.querySelector<HTMLElement>(".chat-pane__versions-help")!;
  await expect.poll(() => document.activeElement).toBe(info);
  await userEvent.keyboard("{Enter}");
  await expect.element(page.elementLocator(help)).toBeVisible();
  const hidden = new Promise<Event>((resolve) => {
    help.addEventListener("overlay-after-hide", resolve, { once: true });
  });
  await userEvent.keyboard("{Escape}");
  expect((await hidden).target).toBe(help);
  expect(help.matches(":popover-open")).toBe(false);
  await expect.element(page.elementLocator(menuSurface)).toBeVisible();
  await expect.poll(() => document.activeElement).toBe(info);
  await userEvent.keyboard(" ");
  await expect.element(page.elementLocator(help)).toBeVisible();

  // The parent parks rendering; only its existing presentation notification is delivered.
  presented = false;
  second.container.inert = true;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  await waitForSolid(() => {
    expect(menuSurface.getClientRects()).toHaveLength(0);
    expect(help.getClientRects()).toHaveLength(0);
  });
  expect(second.container.isConnected).toBe(true);
  expect(second.props.onBranchSelect).not.toHaveBeenCalled();
});
