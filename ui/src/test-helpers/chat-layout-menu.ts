import type { ElementHandle, Locator, Page } from "playwright";
import { expect } from "vitest";

export async function openChatDashboardMenu(scope: Page | Locator): Promise<Locator> {
  const menu = nativePane(scope).locator(".chat-dashboard-menu").filter({ visible: true });
  const trigger = menu.getByRole("button", { name: "Dashboard options", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await menu.getByRole("menu", { name: "Dashboard options", exact: true }).waitFor();
  return menu;
}

export async function closeChatDashboardMenu(scope: Page | Locator): Promise<void> {
  const menu = nativePane(scope).locator(".chat-dashboard-menu").filter({ visible: true });
  await menu.getByRole("button", { name: "Dashboard options", exact: true }).click();
  await menu.getByRole("menu", { name: "Dashboard options", exact: true }).waitFor({
    state: "hidden",
  });
}

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

export function nativePane(scope: Page | Locator): Locator {
  return "mainFrame" in scope
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
}

function nativePanelControl(scope: Page | Locator, name: string | RegExp): Locator | null {
  if (name !== "Focus" && name !== "Restore split" && name !== "Expand Side panel") {
    return null;
  }
  const pane = nativePane(scope);
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
  if (name === "Use current view as default") {
    const menu = await openChatDashboardMenu(scope);
    await menu
      .getByRole("menuitem", { name, exact: true })
      .or(menu.getByRole("menuitemcheckbox", { name, exact: true }))
      .click();
    await menu.getByRole("menu", { name: "Dashboard options", exact: true }).waitFor({
      state: "hidden",
    });
    return;
  }
  const host = nativePane(scope).locator(".chat-mobile-host");
  const closeHost = host
    .locator(".chat-mobile-host__header")
    .getByRole("button", { name: "Close", exact: true });
  const togglesPanel = ["Side panel", "Minimize side panel"].some((label) =>
    typeof name === "string" ? name === label : name.test(label),
  );
  if (
    togglesPanel &&
    (await host.locator(".chat-mobile-host__panels").isVisible()) &&
    (await closeHost.isVisible())
  ) {
    await closeHost.click();
    return;
  }
  const nativeControl = nativePanelControl(scope, name);
  if (
    nativeControl &&
    // Main-pane Focus and Restore belong to Layout while that entry is available.
    (name === "Expand Side panel" ||
      !(await scope.locator("button.chat-pane__layout-trigger:not([inert] *)").first().isVisible()))
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
