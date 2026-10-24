import type { Locator, Page } from "playwright";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";

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

export async function selectChatLayoutAction(
  scope: Page | Locator,
  name: string | RegExp,
): Promise<void> {
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

export async function openChatPanels(
  scope: Page | Locator,
  presentation: "mobile" | "desktop",
): Promise<Locator> {
  const pane = nativePane(scope);
  const headers = ".agent-chat__header--mobile, .sidebar-region__header, [data-region-header]";
  await pane.locator(headers).filter({ visible: true }).first().waitFor();
  await waitForLayoutSettled(pane.page(), "openclaw-chat-pane :is(" + headers + ")");
  // The scenario owns its target layout; old controls may remain visible during a viewport change.
  if (presentation === "mobile") {
    const trigger = pane.locator(".agent-chat__header--mobile .chat-header-session-menu__trigger");
    await trigger.waitFor({ state: "visible" });
    if (!(await pane.locator(".chat-mobile-host").isVisible())) {
      await selectMenuItem(await openSessionActions(pane), "Panels");
    }
    return trigger;
  }
  const trigger = pane
    .locator(".sidebar-region__panels-toggle")
    .getByRole("button", { name: "Panels", exact: true });
  await trigger.waitFor({ state: "visible" });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  return trigger;
}

/** Desktop choices are menu checkboxes; mobile choices are pressed buttons in Advanced. */
export async function openChatConversationOptions(scope: Page | Locator): Promise<Locator> {
  const pane = nativePane(scope);
  const menu = await openSessionActions(pane);
  if (await pane.locator(".agent-chat__header--mobile").isVisible()) {
    await menu.getByRole("menuitem", { name: "Advanced", exact: true }).click();
    const options = pane.locator('.chat-mobile-host__page[data-mobile-page="session-advanced"]');
    await options.waitFor();
    return options;
  }
  await menu.getByRole("menuitem", { name: "View", exact: true }).click();
  await menu.getByRole("menuitemcheckbox", { name: "Reasoning", exact: true }).waitFor();
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
  const headers = ".agent-chat__header--mobile, .sidebar-region__header, [data-region-header]";
  await pane.locator(headers).filter({ visible: true }).first().waitFor();
  await waitForLayoutSettled(pane.page(), "openclaw-chat-pane :is(" + headers + ")");
  const matches = (label: string) => (typeof name === "string" ? name === label : name.test(label));
  const mobile = await pane.locator(".agent-chat__header--mobile").isVisible();
  const host = pane.locator(".chat-mobile-host");
  const side = pane.locator('[data-region-header="side"]');

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
    } else if (mobile) {
      await openChatPanels(pane, "mobile");
    } else {
      await pane
        .locator(".sidebar-region__panels-toggle")
        .getByRole("button", { name: "Panels", exact: true })
        .click();
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
    await openChatPanels(pane, mobile ? "mobile" : "desktop");
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
  if (matches("Focus")) {
    const dashboard = pane.locator(".chat-dashboard-menu").filter({ visible: true });
    if (!mobile && (await dashboard.isVisible())) {
      await selectMenuItem(await openChatDashboardMenu(pane), "Expand Dashboard");
    } else {
      await (mobile ? host.locator(".chat-mobile-host__header") : side)
        .getByRole("button", { name: "Expand Side panel", exact: true })
        .click();
    }
    return;
  }
  if (matches("Swap Chat and Dashboard") || (name instanceof RegExp && name.test("Swap "))) {
    const dashboard = pane.locator(".chat-dashboard-menu").filter({ visible: true });
    if (await dashboard.isVisible()) {
      await selectMenuItem(await openChatDashboardMenu(pane), /^Swap /);
    } else {
      await side.getByRole("button", { name: "Panel position", exact: true }).click();
      await pane.getByRole("menuitem", { name, exact: true }).click();
      await pane.locator(".side-panel-position-menu:visible").waitFor({ state: "hidden" });
    }
    return;
  }
  if (matches("Use current view as default")) {
    await selectMenuItem(await openChatDashboardMenu(pane), name);
    return;
  }
  const menu = await openSessionActions(pane);
  if (matches("Close pane")) {
    if (mobile) {
      await menu.getByRole("menuitem", { name: "Advanced", exact: true }).click();
      await host.getByRole("button", { name: "Close pane", exact: true }).click();
      await host.waitFor({ state: "hidden" });
      return;
    }
    await menu.getByRole("menuitem", { name: "View", exact: true }).click();
  }
  await selectMenuItem(menu, name);
}
