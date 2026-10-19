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
  const pane = nativePane(scope);
  const mobile = pane.locator(".agent-chat__header--mobile");
  if (await mobile.isVisible()) {
    await openSessionActions(pane);
    await pane.getByRole("menuitem", { name: "View", exact: true }).click();
    const menu = pane.locator("openclaw-chat-header-session-menu");
    await menu.locator(".oc-menu:visible").last().waitFor();
    return menu;
  }
  const trigger = pane.getByRole("button", { name: "Panel position", exact: true });
  await trigger.click();
  const menu = pane.locator(".side-panel-position-menu");
  await menu.waitFor();
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
  const pane = nativePane(scope);
  const mobile = pane.locator(".agent-chat__header--mobile");
  const trigger = (await mobile.isVisible())
    ? mobile.locator(".chat-header-session-menu__trigger")
    : pane.getByRole("button", { name: "Panel position", exact: true });
  await trigger.click();
  await pane.locator(".oc-menu:visible").last().waitFor({ state: "hidden" });
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
  await selectNativeLayoutAction(nativePane(scope), name);
}

export function nativePane(scope: Page | Locator): Locator {
  if ("mainFrame" in scope) {
    return scope
      .locator(
        ".chat-pane-cache__pane--active, .chat-split-view__cell--active openclaw-chat-pane.chat-split-view__pane",
      )
      .filter({ visible: true })
      .first();
  }
  return scope
    .locator("xpath=ancestor-or-self::openclaw-chat-pane[1]")
    .or(scope.locator("openclaw-chat-pane").filter({ visible: true }))
    .first();
}

async function openSessionActions(pane: Locator): Promise<Locator> {
  const trigger = pane
    .locator(".chat-header-session-menu__trigger")
    .filter({ visible: true })
    .first();
  const menu = trigger.locator("xpath=ancestor::openclaw-chat-header-session-menu[1]");
  if (!(await menu.locator(".oc-menu:visible").count())) {
    await trigger.click();
  }
  await menu.locator(".oc-menu:visible").first().waitFor();
  return menu;
}

async function selectMenuItem(menu: Locator, name: string | RegExp): Promise<void> {
  await menu
    .getByRole("menuitem", { name, exact: true })
    .or(menu.getByRole("menuitemcheckbox", { name, exact: true }))
    .click();
  await menu.locator(".oc-menu:visible").last().waitFor({ state: "hidden" });
}

async function selectNativeLayoutAction(pane: Locator, name: string | RegExp): Promise<void> {
  const matches = (label: string) => (typeof name === "string" ? name === label : name.test(label));
  const mobile = await pane.locator(".agent-chat__header--mobile").isVisible();
  const host = pane.locator(".chat-mobile-host");
  const side = pane.locator('[data-region-header="side"]');
  const toggle = mobile
    ? pane
        .locator(".agent-chat__header--mobile")
        .getByRole("button", { name: "Panels", exact: true })
    : pane
        .locator(".sidebar-region__panels-toggle")
        .getByRole("button", { name: "Panels", exact: true });

  if (
    matches("Side panel") ||
    matches("Minimize side panel") ||
    (typeof name === "string" && name.startsWith("Collapse "))
  ) {
    if (mobile && (await host.isVisible())) {
      await host
        .locator(".chat-mobile-host__header")
        .getByRole("button", { name: "Close", exact: true })
        .click();
    } else {
      await toggle.click();
    }
    return;
  }
  const panels = [
    ["Review", "Review"],
    ["Review", "Show session changes"],
    ["Files", "Show session files"],
    ["Files", "Collapse session workspace"],
    ["Side chat", "Show side chat"],
    ["Side chat", "Collapse side chat"],
    ["Browser", "Toggle browser panel"],
    ["Desktop", "Toggle desktop panel"],
    ["Terminal", "Toggle terminal"],
    ["Subagents", "Subagents"],
    ["Processes", "Processes"],
    ["Dashboard", "Dashboard"],
    ["Desktop", "Desktop"],
  ] as const;
  const panel = panels.find(([, action]) => matches(action));
  if (panel) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    if (mobile) {
      await host.getByRole("button", { name: "Panels", exact: true }).click();
    }
    const slots: Record<string, string> = {
      Review: "detail",
      Files: "workspace",
      "Side chat": "companion",
      Browser: "browser",
      Desktop: "desktop",
      Terminal: "terminal",
      Subagents: "subagents",
      Processes: "processes",
      Dashboard: "dashboard",
    };
    const retained = pane.locator('[data-panel-slot="' + slots[panel[0]] + '"]');
    const contentId = (await retained.count()) ? await retained.first().getAttribute("id") : null;
    if (contentId) {
      const tab = side
        .locator('[role="tab"][aria-controls=' + JSON.stringify(contentId) + "]")
        .first();
      if (await tab.count()) {
        await tab.click();
        return;
      }
    }
    const launcher = pane.locator(mobile ? ".chat-panel-launcher-mobile" : ".side-panel-launcher");
    const newTab = side.getByRole("button", { name: "New tab", exact: true });
    await launcher.or(newTab).filter({ visible: true }).first().waitFor();
    if (!(await launcher.isVisible())) {
      await newTab.click();
    }
    const option = mobile
      ? launcher.getByRole("button", { name: panel[0], exact: true })
      : launcher.getByRole("button").filter({
          has: pane
            .page()
            .getByText(panel[0], { exact: true })
            .and(pane.page().locator(".side-panel-type-option__label")),
        });
    await option.click();
    return;
  }
  const dock = [
    ["Move side panel left", "Left"],
    ["Move side panel right", "Right"],
    ["Move side panel below", "Below"],
  ].find(([action]) => matches(action!));
  if (dock) {
    await side.getByRole("button", { name: "Panel position", exact: true }).click();
    await pane.getByRole("menuitemradio", { name: dock[1], exact: true }).click();
    await pane.locator(".side-panel-position-menu:visible").waitFor({ state: "hidden" });
    return;
  }
  if (matches("Restore split") || (typeof name === "string" && name.startsWith("Expand "))) {
    if (mobile) {
      await host
        .locator(".chat-mobile-host__header")
        .getByRole("button", {
          name: matches("Restore split") ? "Restore" : "Expand Side panel",
          exact: true,
        })
        .click();
      return;
    }
    const action = side.getByRole("button", {
      name: matches("Restore split") ? "Restore split" : "Expand Side panel",
      exact: true,
    });
    if (await action.isVisible()) {
      await action.click();
      return;
    }
    const dashboard = pane.locator(".chat-dashboard-menu").filter({ visible: true });
    await dashboard.getByRole("button", { name: "Dashboard options", exact: true }).click();
    await selectMenuItem(dashboard, name);
    return;
  }
  if (
    matches("Focus") ||
    matches("Swap Chat and Dashboard") ||
    (name instanceof RegExp && name.test("Swap "))
  ) {
    const dashboard = pane.locator(".chat-dashboard-menu").filter({ visible: true });
    if (await dashboard.isVisible()) {
      await dashboard.getByRole("button", { name: "Dashboard options", exact: true }).click();
      await selectMenuItem(dashboard, matches("Focus") ? "Expand Dashboard" : /^Swap /);
    } else {
      await side.getByRole("button", { name: "Panel position", exact: true }).click();
      await pane.getByRole("menuitem", { name, exact: true }).click();
      await pane.locator(".side-panel-position-menu:visible").waitFor({ state: "hidden" });
    }
    return;
  }
  const menu = await openSessionActions(pane);
  if (matches("Close pane")) {
    await menu.getByRole("menuitem", { name: "View", exact: true }).click();
  }
  await selectMenuItem(menu, name);
}
