import { afterEach, expect, it } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { PRESENTATION_CHANGED_EVENT } from "../../../lit/presentation-binding.ts";
import "../../../components/web-awesome.ts";
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
  const { page } = await import("vitest/browser");
  await i18n.setLocale("en");
  const branches = [
    { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
    { leafEntryId: "other", headline: "Earlier idea", messageCount: 2, active: false },
  ];
  const first = mountChatPaneHeader(containers, { branches });
  await first.container.querySelector("openclaw-chat-pane-versions-menu")?.updateComplete;
  // Cached chats can retain headers with the same pane slot identity in one document.
  first.container.hidden = true;
  first.container.inert = true;

  const owner = new EventTarget();
  let presented = true;
  const second = mountChatPaneHeader(containers, {
    branches,
    presented: { owner, isPresented: () => presented },
  });
  await second.container.querySelector("openclaw-chat-pane-versions-menu")?.updateComplete;
  const menu = second.container.querySelector<HTMLElementTagNameMap["wa-dropdown"]>(
    ".chat-pane__branches-menu",
  )!;
  const trigger = menu.querySelector<HTMLButtonElement>(".chat-pane__branches-trigger")!;
  const info = menu.querySelector<HTMLButtonElement>(".chat-pane__versions-info")!;
  const help = menu.querySelector("wa-popover")!;
  await menu.updateComplete;
  await help.updateComplete;
  const menuSurface = menu.shadowRoot!.querySelector<HTMLElement>('[part="menu"]')!;

  await page.elementLocator(trigger).click();
  await expect.element(page.elementLocator(menuSurface)).toBeVisible();
  await page.elementLocator(info).click();
  await expect.element(page.elementLocator(help.body)).toBeVisible();

  // The parent parks rendering; only its existing presentation notification is delivered.
  presented = false;
  second.container.inert = true;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  expect(menuSurface.getClientRects()).toHaveLength(0);
  expect(help.body.getClientRects()).toHaveLength(0);
  expect(second.container.isConnected).toBe(true);
  expect(second.props.onBranchSelect).not.toHaveBeenCalled();
});
