/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { focusChatComposerFromKeydown } from "../pages/chat/chat-pane-shared.ts";
import {
  containers,
  menuItem,
  menuItemLabels,
  mountMenu,
  menuPanel,
  openSubmenu,
  settleSessionMenu,
} from "../test-helpers/session-menu.ts";
import { createSessionOwnerMenuHarness } from "../test-helpers/session-owner-menu.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import type { SessionMenuAction } from "./session-menu-solid.tsx";

function press(target: EventTarget, key: string, composed = false) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed }),
  );
}
function focusAndPress(item: HTMLElement, key: string, composed = false) {
  item.focus();
  expect(document.activeElement).toBe(item);
  press(document.activeElement!, key, composed);
}
async function reopen(host: Awaited<ReturnType<typeof mountMenu>>, coordinate = 100) {
  host.anchor = { x: coordinate, y: coordinate };
  await settleSessionMenu(host);
}

it("keeps advertised native menu shortcuts ahead of composer autotype", async () => {
  const actions: SessionMenuAction[] = [];
  const host = await mountMenu({
    groups: ["Research", "Personal"],
    onAction: (action) => actions.push(action),
  });
  const root = host.parentElement!;
  const composer = root.appendChild(document.createElement("div"));
  composer.className = "agent-chat__composer-combobox";
  const input = composer.appendChild(document.createElement("textarea"));
  const capture = (event: KeyboardEvent) => focusChatComposerFromKeydown(root, event, input);
  document.addEventListener("keydown", capture, true);
  try {
    const expected: SessionMenuAction[] = [
      { kind: "toggle-archived" },
      { kind: "move-to-group", category: "Research" },
    ];
    for (const [index, key] of ["a", "1"].entries()) {
      if (index) {
        await reopen(host);
      }
      const target = index ? await openSubmenu(host, "Move to group") : host;
      focusAndPress(menuItem(target, index ? "Personal" : "Pin session"), key, true);
      await waitForSolid(() => expect(actions).toEqual(expected.slice(0, index + 1)));
      expect(document.activeElement).not.toBe(input);
    }

    await reopen(host);
    const pin = menuItem(host, "Pin session");
    focusAndPress(pin, "x", true);
    expect(document.activeElement).toBe(input);
    host.remove();
    await Promise.resolve();
    press(pin, "a");
    press(document, "a");
    expect(actions).toEqual(expected);
  } finally {
    document.removeEventListener("keydown", capture, true);
  }
});

it("preserves focus and owner search across property updates", async () => {
  const { context } = createSessionOwnerMenuHarness();
  const host = await mountMenu({ context, session: { label: "First title" } });
  await waitForSolid(() => expect(menuItemLabels(host)).toContain("Assign to…"));
  await settleSessionMenu(host);
  const owner = menuItem(host, "Assign to…");
  const ownerPanel = await openSubmenu(host, "Assign to…");
  await waitForSolid(() => expect(owner.getAttribute("aria-expanded")).toBe("true"));
  const search = ownerPanel.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "Research";
  search.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await waitForSolid(() => expect(menuItemLabels(owner)).toEqual(["Research"]));
  search.focus();
  host.session = { ...host.session, label: "Fresh title", unread: true, archived: true };
  host.work = { pullRequestUrl: "https://example.test/pull/1", worktreePath: null };
  await settleSessionMenu(host);
  await waitForSolid(() => expect(menuItemLabels(host)).toContain("Open PR"));
  expect(owner.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(search);
  expect(search).toMatchObject({ value: "Research" });
  expect(menuItemLabels(host)).toContain("Mark as read");
  expect(menuItemLabels(host)).toContain("Restore session");
});

it("ignores a stale native toggle after reopening the same session", async () => {
  const onClose = vi.fn();
  const trigger = document.body.appendChild(document.createElement("button"));
  containers.push(trigger);
  const menu = await mountMenu({ onClose, trigger });
  const stalePanel = menuPanel(menu);
  focusAndPress(menuItem(menu, "Pin session"), "Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(trigger);

  await reopen(menu, 120);
  stalePanel.dispatchEvent(new Event("toggle"));
  stalePanel.dispatchEvent(new Event("overlay-after-hide"));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(menuPanel(menu)).not.toBe(stalePanel);
  expect(menuPanel(menu).matches(":popover-open")).toBe(true);
});
