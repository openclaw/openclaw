import type { ElementHandle, Locator, Page } from "playwright";
import { expect } from "vitest";

type DomChatLayoutScope = {
  container: ParentNode;
  click: (element: HTMLElement) => Promise<void>;
};

function isChatLayoutMenuOpen(element: Element): boolean {
  return (
    element.isConnected &&
    (element.hasAttribute("open") ||
      Boolean(element.shadowRoot?.querySelector("wa-popup")?.hasAttribute("active")))
  );
}

function waitForMenuShow(menu: Element): Promise<void> {
  return new Promise((resolve) => {
    const shown = (event: Event) => {
      if (event.target === menu) {
        menu.removeEventListener("wa-after-show", shown);
        resolve();
      }
    };
    menu.addEventListener("wa-after-show", shown);
  });
}

async function waitForMenuClose(menu: ElementHandle<Element> | HTMLElement): Promise<void> {
  await expect
    .poll(
      () => ("evaluate" in menu ? menu.evaluate(isChatLayoutMenuOpen) : isChatLayoutMenuOpen(menu)),
      { timeout: 10_000, message: "Layout menu did not finish closing" },
    )
    .toBe(false);
}

export function openChatLayoutMenu(scope: DomChatLayoutScope): Promise<HTMLElement>;
export function openChatLayoutMenu(scope: Page | Locator): Promise<Locator>;
export async function openChatLayoutMenu(
  scope: Page | Locator | DomChatLayoutScope,
): Promise<Locator | HTMLElement> {
  if ("container" in scope) {
    const menu = scope.container.querySelector<HTMLElement>(".chat-pane__layout-menu");
    const trigger = menu?.querySelector<HTMLElement>('button[aria-label="Layout"]');
    if (!menu || !trigger) {
      throw new Error("Expected a chat Layout menu");
    }
    if (!menu.hasAttribute("open")) {
      const shown = waitForMenuShow(menu);
      await scope.click(trigger);
      await shown;
    }
    return menu;
  }
  const trigger = scope.getByRole("button", { name: "Layout", exact: true }).first();
  const menu = trigger.locator("..");
  if ((await menu.getAttribute("open")) === null) {
    const element = await menu.elementHandle();
    if (!element) {
      throw new Error("Expected a chat Layout menu");
    }
    try {
      await Promise.all([element.evaluate(waitForMenuShow), trigger.click()]);
    } finally {
      await element.dispose();
    }
  }
  return menu;
}

export async function closeChatLayoutMenu(
  scope: Page | Locator | DomChatLayoutScope,
): Promise<void> {
  if ("container" in scope) {
    const menu = scope.container.querySelector<HTMLElement>(".chat-pane__layout-menu");
    const trigger = menu?.querySelector<HTMLElement>('button[aria-label="Layout"]');
    if (!menu || !trigger) {
      throw new Error("Expected a chat Layout menu");
    }
    if (menu.hasAttribute("open")) {
      await scope.click(trigger);
    }
    await waitForMenuClose(menu);
    return;
  }
  const trigger = scope.getByRole("button", { name: "Layout", exact: true }).first();
  const menu = trigger.locator("..");
  if ((await menu.getAttribute("open")) !== null) {
    await trigger.click();
  }
  const element = await menu.elementHandle();
  if (element) {
    try {
      await waitForMenuClose(element);
    } finally {
      await element.dispose();
    }
  }
}

export async function selectChatLayoutAction(
  scope: Page | Locator | DomChatLayoutScope,
  name: string | RegExp,
): Promise<void> {
  if ("container" in scope) {
    const menu = await openChatLayoutMenu(scope);
    const action = [...menu.querySelectorAll<HTMLElement>("wa-dropdown-item")].find((item) => {
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
  const menu = await openChatLayoutMenu(scope);
  const action = menu
    .getByRole("menuitem", { name, exact: true })
    .or(menu.getByRole("menuitemcheckbox", { name, exact: true }));
  const element = await menu.elementHandle();
  if (!element) {
    throw new Error("Expected a chat Layout menu");
  }
  try {
    await action.click();
    // Wait for Web Awesome's popup to finish hiding before another menu action.
    await waitForMenuClose(element);
  } finally {
    await element.dispose();
  }
}
