import type { Locator, Page } from "playwright";

type DomChatLayoutScope = {
  container: ParentNode;
  click: (element: HTMLElement) => Promise<void>;
};

async function waitForMenuClose(element: Element): Promise<void> {
  while (
    element.isConnected &&
    (element.hasAttribute("open") ||
      element.shadowRoot?.querySelector("wa-popup")?.hasAttribute("active"))
  ) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
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
    await scope.click(trigger);
    return menu;
  }
  const trigger = scope.getByRole("button", { name: "Layout", exact: true }).first();
  const menu = trigger.locator("..");
  await trigger.click();
  return menu;
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
  await action.click();
  // Wait for Web Awesome's popup to finish hiding before another menu action.
  await element?.evaluate(waitForMenuClose);
  await element?.dispose();
}
