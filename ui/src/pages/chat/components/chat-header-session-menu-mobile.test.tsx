/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { openSubmenu } from "../../../test-helpers/session-menu.ts";
import type { HeaderSessionMenuPage } from "./chat-header-session-menu-mobile.tsx";
import "./chat-header-session-menu.ts";

afterEach(() => document.body.replaceChildren());

async function menuFixture(mobile: boolean | undefined) {
  const menu = document.createElement("openclaw-chat-header-session-menu");
  const onAction = vi.fn();
  const open = vi.fn<(page: HeaderSessionMenuPage, source: HTMLElement) => void>();
  const close = vi.fn();
  menu.mobile = mobile;
  menu.compact = true;
  menu.mobileHost = { open, close };
  menu.onAction = onAction;
  menu.copyMarkdownAllowed = true;
  menu.archiveAllowed = true;
  menu.groups = ["Zebra", "Alpha"];
  menu.session = { ...menu.session, sessionId: "session-123", label: "Session", category: "Zebra" };
  document.body.append(menu);
  await menu.updateComplete;
  expect(menu.openMenu()).toBe(true);
  flush();
  await menu.updateComplete;
  return { menu, onAction, open, close };
}

it("copies through the native action and closes the whole mobile menu", async () => {
  const { menu, onAction, open } = await menuFixture(true);
  const panel = menu.querySelector<HTMLElement>(".chat-header-session-menu__panel")!;
  expect(menu.querySelector('[value="copy-session-link"]')).toBeNull();
  await openSubmenu(panel, "Copy");
  const copy = menu.querySelector<HTMLButtonElement>('[value="copy-session-id"]')!;
  expect(copy.textContent).toContain("Copy session ID");
  copy.click();
  flush();
  await menu.updateComplete;
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ kind: "copy-session-id" });
  expect(panel.matches(":popover-open")).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

it("opens a controlled group picker without autofocus and dispatches the selected group", async () => {
  const { menu, open, close, onAction } = await menuFixture(true);
  menu.querySelector<HTMLButtonElement>('[value="compact:open-group"]')!.click();
  flush();
  expect(open).toHaveBeenCalledOnce();
  const [page, source] = open.mock.calls[0]!;
  expect(page.key).toBe("session-group");
  expect(source).toBe(menu.querySelector(".chat-header-session-menu__trigger"));
  menu.mobilePageOpen = true;
  const mounted = mountSolid(() => [page.headerActions, page.content]);
  flush();
  expect(mounted.container.querySelector('input[type="search"]')).toBeNull();
  const buttons = () => [
    ...mounted.container.querySelectorAll<HTMLButtonElement>(".session-actions-page__group button"),
  ];
  expect(
    buttons()
      .slice(0, 2)
      .map((button) => button.textContent),
  ).toEqual(["Alpha", "Zebra"]);
  mounted.container.querySelector<HTMLButtonElement>(".chat-mobile-host__circle")!.click();
  flush();
  const search = mounted.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  expect(document.activeElement).not.toBe(search);
  search.value = "alp";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(buttons().some((button) => button.textContent === "Zebra")).toBe(false);
  buttons()
    .find((button) => button.textContent === "Alpha")!
    .click();
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ kind: "move-to-group", category: "Alpha" });
  expect(close).toHaveBeenCalledOnce();
});

it.each([false, undefined])(
  "uses explicit desktop presentation for the palette delta: %s",
  async (mobile) => {
    const { menu } = await menuFixture(mobile);
    expect(Boolean(menu.querySelector('[value="open-command-palette"]'))).toBe(
      mobile === undefined,
    );
    expect(menu.querySelector('[value="rename"]')?.textContent).toContain("Rename…");
    expect(menu.querySelector('[value="mobile-copy"]')).toBeNull();
  },
);

it.each([false, true])(
  "keeps the gated Speech bubbles preference reachable in mobile Advanced: %s",
  async (enabled) => {
    const { menu, open, close } = await menuFixture(true);
    const onSettingsChange = vi.fn();
    menu.bubbleModeEnabled = enabled;
    menu.session = { ...menu.session, target: { key: "agent:main:testing" } };
    menu.onSettingsChange = onSettingsChange;
    await menu.updateComplete;
    menu.querySelector<HTMLButtonElement>('[value="mobile-advanced"]')!.click();
    flush();
    const page = open.mock.calls[0]![0];
    menu.mobilePageOpen = true;
    const mounted = mountSolid(() => page.content);
    flush();
    const conversation = mounted.container.querySelector("section")!;
    const bubbles = [...conversation.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Speech bubbles",
    );
    expect(Boolean(bubbles)).toBe(enabled);
    if (bubbles) {
      bubbles.click();
      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({
        chatBubbleSessionKeys: ["agent:main:testing"],
        chatBubbleDisabledSessionKeys: undefined,
      });
    } else {
      expect(onSettingsChange).not.toHaveBeenCalled();
    }
    expect(close).not.toHaveBeenCalled();
  },
);

it("dismisses the controlled Advanced page after a fork action", async () => {
  const { menu, open, close, onAction } = await menuFixture(true);
  menu.forkDisabled = false;
  await menu.updateComplete;
  menu.querySelector<HTMLButtonElement>('[value="mobile-advanced"]')!.click();
  flush();
  const page = open.mock.calls[0]![0];
  menu.mobilePageOpen = true;
  const mounted = mountSolid(() => page.content);
  flush();
  const fork = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Fork conversation",
  );
  expect(fork?.disabled).toBe(false);
  fork!.click();
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ kind: "fork" });
  expect(close).toHaveBeenCalledOnce();
});
