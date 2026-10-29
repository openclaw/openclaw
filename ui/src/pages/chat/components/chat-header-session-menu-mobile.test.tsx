/* @vitest-environment jsdom */

import { createSignal, flush, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { openSubmenu } from "../../../test-helpers/session-menu.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { chatPaneLayoutModel } from "./chat-header-panel-actions.tsx";
import type { HeaderSessionMenuPage } from "./chat-header-session-menu-mobile.tsx";
import "./chat-header-session-menu.ts";

afterEach(() => document.body.replaceChildren());

async function menuFixture(mobile: boolean | undefined) {
  const menu = document.createElement("openclaw-chat-header-session-menu");
  const onAction = vi.fn();
  const [currentPage, setCurrentPage] = createSignal<HeaderSessionMenuPage>();
  const [presented, setPresented] = createSignal(true);
  const open = vi.fn<(page: HeaderSessionMenuPage, source: HTMLElement) => void>(setCurrentPage);
  const close = vi.fn<() => void>(() => setCurrentPage(undefined));
  menu.mobile = mobile;
  menu.compact = true;
  menu.mobileHost = { open, close, isCurrent: (page) => presented() && currentPage() === page };
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
  await waitForSolid(() =>
    expect(
      menu.querySelector(mobile ? '[value="mobile-copy"]' : '[value="rename"]'),
    ).not.toBeNull(),
  );
  return { menu, onAction, open, close, currentPage, setCurrentPage, setPresented };
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

  const retiredPage = mounted.container.querySelector(".session-actions-page")!;
  mounted.unmount();
  expect(menu.openMenu()).toBe(true);
  flush();
  menu.querySelector<HTMLButtonElement>('[value="compact:open-group"]')!.click();
  close();
  flush();
  menu.groups = ["Alpine"];
  await menu.updateComplete;
  expect(retiredPage.textContent).toContain("Alpha");
  expect(retiredPage.textContent).not.toContain("Alpine");
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

it("closes the originating split pane from mobile Advanced without exposing legacy View", async () => {
  const first = await menuFixture(true);
  const second = await menuFixture(true);
  const focusedAtClose: (Element | null)[] = [];
  const onClosePane = vi.fn(() => {
    focusedAtClose.push(document.activeElement);
  });
  const trigger = second.menu.querySelector<HTMLButtonElement>(
    ".chat-header-session-menu__trigger",
  )!;
  second.close.mockImplementation(() => trigger.focus());
  const secondLayout = {
    paneId: "pane-second",
    narrow: true,
    mobile: true,
    actionsDisabled: true,
    onClosePane,
  };
  first.menu.viewActions = chatPaneLayoutModel({
    ...secondLayout,
    paneId: "pane-first",
    actionsDisabled: false,
  }).allActions;
  second.menu.viewActions = chatPaneLayoutModel(secondLayout).allActions;
  second.menu.deleteAllowed = true;
  await second.menu.updateComplete;
  expect(second.menu.querySelector('[value="compact:open-view"]')).toBeNull();
  second.menu.querySelector<HTMLButtonElement>('[value="mobile-advanced"]')!.click();
  flush();
  const page = second.open.mock.calls[0]![0];
  second.menu.mobilePageOpen = true;
  const mounted = mountSolid(() => page.content);
  flush();
  const session = () =>
    [...mounted.container.querySelectorAll("section")].find(
      (section) => section.querySelector("h3")?.textContent === "Session",
    )!;
  const closePaneButton = () =>
    [...session().querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Close pane",
    )!;
  expect(closePaneButton()).toBeDefined();
  expect(closePaneButton().disabled).toBe(true);
  closePaneButton().click();
  expect(onClosePane).not.toHaveBeenCalled();
  expect(second.close).not.toHaveBeenCalled();

  secondLayout.actionsDisabled = false;
  second.menu.viewActions = chatPaneLayoutModel(secondLayout).allActions;
  await second.menu.updateComplete;
  flush();
  const labels = [...session().querySelectorAll("button")].map((button) =>
    button.textContent?.trim(),
  );
  expect(labels).toContain("Delete");
  expect(labels.indexOf("Close pane")).toBeLessThan(labels.indexOf("Delete"));
  expect(closePaneButton().disabled).toBe(false);
  closePaneButton().focus();
  closePaneButton().click();
  expect(onClosePane).toHaveBeenCalledExactlyOnceWith("pane-second");
  expect(focusedAtClose).toEqual([trigger]);
  expect(second.close).toHaveBeenCalledOnce();
  expect(first.close).not.toHaveBeenCalled();
  expect(first.onAction).not.toHaveBeenCalled();
  expect(second.onAction).not.toHaveBeenCalled();
});

it("omits pane closure from mobile Advanced for a single pane", async () => {
  const { menu, open } = await menuFixture(true);
  menu.viewActions = chatPaneLayoutModel({
    paneId: "only-pane",
    narrow: true,
    mobile: true,
  }).allActions;
  await menu.updateComplete;
  menu.querySelector<HTMLButtonElement>('[value="mobile-advanced"]')!.click();
  flush();
  menu.mobilePageOpen = true;
  const mounted = mountSolid(() => open.mock.calls[0]![0].content);
  flush();
  expect(mounted.container.textContent).not.toContain("Close pane");
  expect(menu.querySelector('[value="compact:open-view"]')).toBeNull();
});

it.each(["keyboard", "pointer", "close", "suspend", "newer focus", "dispose"] as const)(
  "only consumes the current native appearance keyboard request: %s",
  async (entry) => {
    const { menu, currentPage, close, setCurrentPage, setPresented } = await menuFixture(true);
    const mounted = mountSolid(() => (
      <Show when={currentPage()} keyed>
        {(page) => page.content}
      </Show>
    ));
    menu.querySelector<HTMLButtonElement>('[value="mobile-advanced"]')!.click();
    flush();
    const appearance = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Icon & color",
    )!;
    const advancedPage = currentPage()!;
    appearance.focus();
    appearance.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: entry === "pointer" ? 1 : 0 }),
    );
    const newer = document.createElement("button");
    document.body.append(newer);
    if (entry === "close") {
      close();
    } else if (entry === "suspend") {
      setPresented(false);
    } else if (entry === "newer focus") {
      newer.focus();
    } else if (entry === "dispose") {
      menu.remove();
    }
    flush();
    const firstColor =
      mounted.container.querySelector<HTMLButtonElement>('[aria-label="No color"]');
    if (entry === "keyboard") {
      expect(firstColor).not.toBeNull();
      expect(document.activeElement).toBe(firstColor);
      const appearancePage = currentPage()!;
      newer.focus();
      setCurrentPage(advancedPage);
      flush();
      expect(mounted.container.contains(appearance)).toBe(true);
      setCurrentPage(appearancePage);
      flush();
      expect(mounted.container.querySelector('[aria-label="No color"]')).toBe(firstColor);
      expect(document.activeElement).toBe(newer);
    } else {
      expect(document.activeElement).not.toBe(firstColor);
      if (entry === "suspend") {
        expect(firstColor?.isConnected).toBe(true);
        setPresented(true);
        flush();
        expect(document.activeElement).not.toBe(firstColor);
      }
      if (entry === "newer focus") {
        expect(document.activeElement).toBe(newer);
      }
    }
  },
);
