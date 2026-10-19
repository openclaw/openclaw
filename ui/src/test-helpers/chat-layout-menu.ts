import type { ElementHandle, Locator, Page } from "playwright";
import { expect } from "vitest";

type DomChatLayoutScope = {
  container: ParentNode;
  click: (element: HTMLElement) => Promise<void>;
};

function domMenu(scope: DomChatLayoutScope) {
  const menu = scope.container.querySelector<HTMLElement>(".chat-pane__layout-menu");
  const trigger = menu?.querySelector<HTMLElement>("button.chat-pane__layout-trigger");
  if (!menu || !trigger) {
    throw new Error("Expected a chat Layout menu");
  }
  return { menu, trigger };
}

function isChatLayoutMenuOpen(element: Element): boolean {
  const surface = element.querySelector<HTMLElement>(".oc-menu");
  return (
    element.isConnected &&
    (surface?.dataset.phase === "opening" || surface?.dataset.phase === "open")
  );
}

function waitForMenuShow(menu: Element): Promise<void> {
  const surface = menu.querySelector<HTMLElement>(".oc-menu");
  if (!surface) {
    throw new Error("Expected a native Layout menu surface");
  }
  if (surface.dataset.phase === "open") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    surface.addEventListener("overlay-after-show", () => resolve(), { once: true });
  });
}

function isChatLayoutMenuClosed(element: Element): boolean {
  const surface = element.querySelector<HTMLElement>(".oc-menu");
  return !element.isConnected || !surface || surface.dataset.phase === "hidden";
}

async function waitForMenuClose(menu: ElementHandle<Element> | HTMLElement): Promise<void> {
  await expect
    .poll(
      () =>
        "evaluate" in menu ? menu.evaluate(isChatLayoutMenuClosed) : isChatLayoutMenuClosed(menu),
      { timeout: 10_000, message: "Layout menu did not finish closing" },
    )
    .toBe(true);
}

export function openChatLayoutMenu(scope: DomChatLayoutScope): Promise<HTMLElement>;
export function openChatLayoutMenu(scope: Page | Locator): Promise<Locator>;
export async function openChatLayoutMenu(
  scope: Page | Locator | DomChatLayoutScope,
): Promise<Locator | HTMLElement> {
  if ("container" in scope) {
    const { menu, trigger } = domMenu(scope);
    const shown = waitForMenuShow(menu);
    if (!isChatLayoutMenuOpen(menu)) {
      await scope.click(trigger);
    }
    await shown;
    return menu;
  }
  const trigger = scope.locator("button.chat-pane__layout-trigger:not([inert] *)").first();
  const menu = trigger.locator("..");
  if (!(await menu.evaluate(isChatLayoutMenuOpen))) {
    await using element = await menu.elementHandle();
    if (!element) {
      throw new Error("Expected a chat Layout menu");
    }
    await Promise.all([element.evaluate(waitForMenuShow), trigger.click()]);
  } else {
    await menu.evaluate(waitForMenuShow);
  }
  return menu;
}

export async function closeChatLayoutMenu(
  scope: Page | Locator | DomChatLayoutScope,
): Promise<void> {
  if ("container" in scope) {
    const { menu, trigger } = domMenu(scope);
    if (isChatLayoutMenuOpen(menu)) {
      await scope.click(trigger);
    }
    await waitForMenuClose(menu);
    return;
  }
  const trigger = scope.locator("button.chat-pane__layout-trigger:not([inert] *)").first();
  const menu = trigger.locator("..");
  if (await menu.evaluate(isChatLayoutMenuOpen)) {
    await trigger.click();
  }
  await using element = await menu.elementHandle();
  if (element) {
    await waitForMenuClose(element);
  }
}

function nativePanelControl(scope: Page | Locator, name: string | RegExp): Locator | null {
  if (name !== "Focus" && name !== "Restore split") {
    return null;
  }
  const pane =
    "mainFrame" in scope
      ? scope
          .locator(
            ".chat-pane-cache__pane--active, .chat-split-view__cell--active openclaw-chat-pane.chat-split-view__pane",
          )
          .filter({ visible: true })
          .first()
      : scope
          .locator("xpath=ancestor-or-self::openclaw-chat-pane[1]")
          .or(scope.locator("openclaw-chat-pane").filter({ visible: true }))
          .first();
  const restore = name === "Restore split";
  return pane
    .locator('.sidebar-region--desktop [data-region-header="side"]')
    .getByRole("button", { name: restore ? "Restore split" : "Expand Side panel", exact: true })
    .or(
      pane
        .locator(".chat-mobile-host__header")
        .getByRole("button", { name: restore ? "Restore" : "Expand Side panel", exact: true }),
    )
    .filter({ visible: true })
    .first();
}

export async function selectChatLayoutAction(
  scope: Page | Locator | DomChatLayoutScope,
  name: string | RegExp,
): Promise<void> {
  if ("container" in scope) {
    const menu = await openChatLayoutMenu(scope);
    const action = [...menu.querySelectorAll<HTMLElement>("[role^=menuitem]")].find((item) => {
      const label = item.getAttribute("aria-label") ?? item.textContent?.trim() ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
    if (!action) {
      throw new Error(`Expected chat Layout action: ${String(name)}`);
    }
    await scope.click(action);
    await waitForMenuClose(menu);
    return;
  }
  const nativeControl = nativePanelControl(scope, name);
  if (
    nativeControl &&
    // Layout Focus targets the main pane; keep that action while its entry is available.
    (name !== "Focus" ||
      !(await scope
        .locator("button.chat-pane__layout-trigger:not([inert] *)")
        .first()
        .isVisible())) &&
    (await nativeControl.isVisible())
  ) {
    await nativeControl.click();
    return;
  }
  const menu = await openChatLayoutMenu(scope);
  const action = menu
    .getByRole("menuitem", { name, exact: true })
    .or(menu.getByRole("menuitemcheckbox", { name, exact: true }));
  await using element = await menu.elementHandle();
  if (!element) {
    throw new Error("Expected a chat Layout menu");
  }
  await action.click();
  // The overlay closes before actions can change the retained header.
  await waitForMenuClose(element);
}
