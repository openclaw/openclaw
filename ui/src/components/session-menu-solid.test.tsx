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
import { SessionMenu } from "./session-menu-solid.tsx";

it("keeps advertised native menu shortcuts ahead of composer autotype", async () => {
  const actions: unknown[] = [];
  const host = await mountMenu({
    archiveAllowed: true,
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
    menuItem(host, "Pin session").focus();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true, composed: true }),
    );
    await waitForSolid(() => expect(actions).toEqual([{ kind: "toggle-archived" }]));
    expect(document.activeElement).not.toBe(input);

    host.anchor = { x: 100, y: 100 };
    await settleSessionMenu(host);
    const group = await openSubmenu(host, "Move to group");
    menuItem(group, "Personal").focus();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true, composed: true }),
    );
    await waitForSolid(() =>
      expect(actions).toEqual([
        { kind: "toggle-archived" },
        { kind: "move-to-group", category: "Research" },
      ]),
    );
    expect(document.activeElement).not.toBe(input);

    host.anchor = { x: 100, y: 100 };
    await settleSessionMenu(host);
    menuItem(host, "Pin session").focus();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true, composed: true }),
    );
    expect(document.activeElement).toBe(input);
  } finally {
    document.removeEventListener("keydown", capture, true);
  }
});

it("updates registered menu props and retires its keyboard owner when unmounted", async () => {
  const calls: string[] = [];
  const host = await mountMenu({
    session: { label: "Synthetic session", archived: false },
    archiveAllowed: true,
    deleteAllowed: true,
    onClose: () => calls.push("close"),
    onAction: (action) => calls.push(action.kind),
  });
  await waitForSolid(() =>
    expect(host.querySelector('[data-value="toggle-archived"]')?.textContent).toContain(
      "Archive session",
    ),
  );
  host.session = { ...host.session, archived: true };
  await settleSessionMenu(host);
  expect(host.querySelector('[data-value="toggle-archived"]')?.textContent).toContain(
    "Restore session",
  );
  const pin = menuItem(host, "Pin session");
  pin.focus();
  pin.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true }));
  expect(calls).toEqual(["close", "delete"]);
  host.remove();
  await Promise.resolve();
  pin.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", cancelable: true }));
  expect(calls).toEqual(["close", "delete"]);
});

it("preserves focus and owner search with the Solid application provider", async () => {
  const { context } = createSessionOwnerMenuHarness();
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(
    () => (
      <SessionMenu session={{ ...EMPTY_SESSION_MENU_DATA, label: "First title" }} archiveAllowed />
    ),
    { wrapper: provider.wrapper },
  );
  const host = mounted.container.querySelector("openclaw-session-menu")!;
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
  host.work = { loading: false, pullRequestUrl: "https://example.test/pull/1", worktreePath: null };
  await settleSessionMenu(host);
  await waitForSolid(() => expect(menuItemLabels(host)).toContain("Open PR"));
  expect(menuItem(host, "Assign to…")).toBe(owner);
  expect(owner.getAttribute("aria-expanded")).toBe("true");
  expect(menuPanel(owner)).toBe(ownerPanel);
  expect(ownerPanel.querySelector('input[type="search"]')).toBe(search);
  expect(search.value).toBe("Research");
  expect(document.activeElement).toBe(search);
  expect(menuItemLabels(host)).toContain("Mark as read");
});

it("ignores a stale native toggle after reopening the same session", async () => {
  const onClose = vi.fn();
  const trigger = document.body.appendChild(document.createElement("button"));
  containers.push(trigger);
  const escape = (item: HTMLElement) =>
    item.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  const menu = await mountMenu({ onClose, trigger });
  const stalePanel = menuPanel(menu);
  const advanced = menuItem(menu, "Advanced");
  const child = await openSubmenu(menu, "Advanced");
  const childItem = menuItem(child, "Icon & color");
  childItem.focus();
  escape(childItem);
  expect(child.matches(":popover-open")).toBe(false);
  expect(stalePanel.matches(":popover-open")).toBe(true);
  expect(document.activeElement).toBe(advanced);
  expect(onClose).not.toHaveBeenCalled();
  escape(advanced);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(trigger);

  menu.anchor = { x: 120, y: 120 };
  await settleSessionMenu(menu);
  stalePanel.dispatchEvent(new Event("toggle"));
  stalePanel.dispatchEvent(new Event("overlay-after-hide"));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(menuPanel(menu)).not.toBe(stalePanel);
  expect(menuPanel(menu).matches(":popover-open")).toBe(true);
});
