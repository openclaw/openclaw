/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { focusChatComposerFromPrintableKeydown } from "../pages/chat/chat-pane-shared.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
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
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { EMPTY_SESSION_MENU_DATA } from "./session-menu-actions.ts";
import { SessionMenu, type SessionMenuAction } from "./session-menu-solid.tsx";

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
  const capture = (event: KeyboardEvent) =>
    focusChatComposerFromPrintableKeydown(root, event, input);
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
    focusAndPress(menuItem(host, "Pin session"), "x", true);
    expect(document.activeElement).toBe(input);
  } finally {
    document.removeEventListener("keydown", capture, true);
  }
});

it("updates registered menu props and retires its keyboard owner when unmounted", async () => {
  const calls: string[] = [];
  const host = await mountMenu({
    onClose: () => calls.push("close"),
    onAction: (action) => calls.push(action.kind),
  });
  const archiveLabel = () => host.querySelector('[data-value="toggle-archived"]')?.textContent;
  await waitForSolid(() => expect(archiveLabel()).toContain("Archive session"));
  host.session = { ...host.session, archived: true };
  await settleSessionMenu(host);
  expect(archiveLabel()).toContain("Restore session");
  const pin = menuItem(host, "Pin session");
  focusAndPress(pin, "d");
  expect(calls).toEqual(["close", "delete"]);
  host.remove();
  await Promise.resolve();
  press(pin, "d");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", cancelable: true }));
  expect(calls).toEqual(["close", "delete"]);
});

it("preserves focus and owner search with the Solid application provider", async () => {
  const { context } = createSessionOwnerMenuHarness();
  const { container } = mountSolid(
    () => (
      <SessionMenu session={{ ...EMPTY_SESSION_MENU_DATA, label: "First title" }} archiveAllowed />
    ),
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  const host = container.querySelector("openclaw-session-menu")!;
  await waitForSolid(() => expect(menuItemLabels(host)).toContain("Assign to…"));
  await settleSessionMenu(host);
  const pin = menuItem(host, "Pin session");
  pin.focus();
  expect(document.activeElement).toBe(pin);
  host.session = { ...host.session, label: "Fresh title" };
  await settleSessionMenu(host);
  expect(menuItem(host, "Pin session")).toBe(pin);
  expect(document.activeElement).toBe(pin);

  const owner = menuItem(host, "Assign to…");
  const ownerPanel = await openSubmenu(host, "Assign to…");
  await waitForSolid(() => expect(owner.getAttribute("aria-expanded")).toBe("true"));
  const search = ownerPanel.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "Research";
  search.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await waitForSolid(() => expect(menuItemLabels(owner)).toEqual(["Research"]));
  search.focus();
  host.session = { ...host.session, unread: true };
  host.work = { pullRequestUrl: "https://example.test/pull/1", worktreePath: null };
  await settleSessionMenu(host);
  await waitForSolid(() => expect(menuItemLabels(host)).toContain("Open PR"));
  expect(menuItem(host, "Assign to…")).toBe(owner);
  expect(owner.getAttribute("aria-expanded")).toBe("true");
  expect(menuPanel(owner)).toBe(ownerPanel);
  expect(ownerPanel.querySelector('input[type="search"]')).toBe(search);
  expect(document.activeElement).toBe(search);
  expect(search).toMatchObject({ value: "Research" });
  expect(menuItemLabels(host)).toContain("Mark as read");
});

it("ignores a stale native toggle after reopening the same session", async () => {
  const onClose = vi.fn();
  const trigger = document.body.appendChild(document.createElement("button"));
  containers.push(trigger);
  const menu = await mountMenu({ onClose, trigger });
  const stalePanel = menuPanel(menu);
  const advanced = menuItem(menu, "Advanced");
  const child = await openSubmenu(menu, "Advanced");
  const childItem = menuItem(child, "Icon & color");
  focusAndPress(childItem, "Escape");
  expect(child.matches(":popover-open")).toBe(false);
  expect(stalePanel.matches(":popover-open")).toBe(true);
  expect(document.activeElement).toBe(advanced);
  expect(onClose).not.toHaveBeenCalled();
  press(advanced, "Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(trigger);

  await reopen(menu, 120);
  stalePanel.dispatchEvent(new Event("toggle"));
  stalePanel.dispatchEvent(new Event("overlay-after-hide"));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(menuPanel(menu)).not.toBe(stalePanel);
  expect(menuPanel(menu).matches(":popover-open")).toBe(true);
});
