import type { Locator, Page } from "playwright";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";

const button = (scope: Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: true });
const mobileHeader = (pane: Locator) => pane.locator(".agent-chat__header--mobile");
const panelsToggle = (pane: Locator, mobile: boolean) =>
  button(mobile ? mobileHeader(pane) : pane.locator(".sidebar-region__panels-toggle"), "Panels");

async function waitForPanelLayout(pane: Locator): Promise<void> {
  const headers = ".agent-chat__header--mobile, .sidebar-region__header, [data-region-header]";
  await pane.locator(headers).filter({ visible: true }).first().waitFor();
  await waitForLayoutSettled(pane.page(), "openclaw-chat-pane :is(" + headers + ")");
}

export async function openChatDashboardMenu(scope: Page | Locator): Promise<Locator> {
  const menu = nativePane(scope).locator(".chat-dashboard-menu").filter({ visible: true });
  const trigger = button(menu, "Dashboard options");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await menu.getByRole("menu", { name: "Dashboard options", exact: true }).waitFor();
  return menu;
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
  await waitForPanelLayout(pane);
  // The scenario owns its target layout; old controls may remain visible during a viewport change.
  if (presentation === "mobile") {
    await mobileHeader(pane).waitFor({ state: "visible" });
    const trigger = panelsToggle(pane, true);
    if (await trigger.isVisible()) {
      if (!(await pane.locator(".chat-mobile-host").isVisible())) {
        await trigger.click();
      }
      return trigger;
    }
    const menu = await openSessionActions(pane);
    await menu.getByRole("menuitem", { name: "Panels", exact: true }).click();
    return menu.locator(".chat-header-session-menu__trigger");
  }
  const trigger = panelsToggle(pane, false);
  await trigger.waitFor({ state: "visible" });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  return trigger;
}

async function selectMenuItem(menu: Locator, name: string | RegExp): Promise<void> {
  await menu
    .getByRole("menuitem", { name, exact: true })
    .or(menu.getByRole("menuitemcheckbox", { name, exact: true }))
    .click();
  await menu.locator(".oc-menu:visible").last().waitFor({ state: "hidden" });
}

async function selectNativeLayoutAction(pane: Locator, name: string | RegExp): Promise<void> {
  await waitForPanelLayout(pane);
  const matches = (label: string) => (typeof name === "string" ? name === label : name.test(label));
  const mobile = await mobileHeader(pane).isVisible();
  const host = pane.locator(".chat-mobile-host");
  const side = pane.locator('[data-region-header="side"]');
  const toggle = panelsToggle(pane, mobile);

  if (
    matches("Side panel") ||
    matches("Minimize side panel") ||
    (typeof name === "string" && name.startsWith("Collapse "))
  ) {
    if (mobile && (await host.isVisible())) {
      await button(host.locator(".chat-mobile-host__header"), "Close").click();
    } else if (mobile) {
      await openChatPanels(pane, "mobile");
    } else {
      await toggle.click();
    }
    return;
  }
  const panels = [
    ["Review", "Review", "detail"],
    ["Review", "Show session changes", "detail"],
    ["Files", "Show session files", "workspace"],
    ["Files", "Collapse session workspace", "workspace"],
    ["Side chat", "Show side chat", "companion"],
    ["Side chat", "Collapse side chat", "companion"],
    ["Browser", "Toggle browser panel", "browser"],
    ["Desktop", "Toggle desktop panel", "desktop"],
    ["Terminal", "Toggle terminal", "terminal"],
    ["Subagents", "Subagents", "subagents"],
    ["Processes", "Processes", "processes"],
    ["Dashboard", "Dashboard", "dashboard"],
    ["Desktop", "Desktop", "desktop"],
  ] as const;
  const panel = panels.find(([, action]) => matches(action));
  if (panel) {
    await openChatPanels(pane, mobile ? "mobile" : "desktop");
    if (mobile) {
      await button(host, "Panels").click();
    }
    const retained = pane.locator('[data-panel-slot="' + panel[2] + '"]');
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
    const newTab = button(side, "New tab");
    await launcher.or(newTab).filter({ visible: true }).first().waitFor();
    if (!(await launcher.isVisible())) {
      await newTab.click();
    }
    const option = mobile
      ? button(launcher, panel[0])
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
    await button(side, "Panel position").click();
    await pane.getByRole("menuitemradio", { name: dock[1], exact: true }).click();
    await pane.locator(".side-panel-position-menu:visible").waitFor({ state: "hidden" });
    return;
  }
  if (matches("Restore split") || (typeof name === "string" && name.startsWith("Expand "))) {
    if (mobile) {
      await button(
        host.locator(".chat-mobile-host__header"),
        matches("Restore split") ? "Restore" : "Expand Side panel",
      ).click();
      return;
    }
    const action = button(side, matches("Restore split") ? "Restore split" : "Expand Side panel");
    if (await action.isVisible()) {
      await action.click();
      return;
    }
    const dashboard = pane.locator(".chat-dashboard-menu").filter({ visible: true });
    await button(dashboard, "Dashboard options").click();
    await selectMenuItem(dashboard, name);
    return;
  }
  if (matches("Focus")) {
    const dashboard = pane.locator(".chat-dashboard-menu").filter({ visible: true });
    if (!mobile && (await dashboard.isVisible())) {
      await selectMenuItem(await openChatDashboardMenu(pane), "Expand Dashboard");
    } else {
      await button(
        mobile ? host.locator(".chat-mobile-host__header") : side,
        "Expand Side panel",
      ).click();
    }
    return;
  }
  if (matches("Swap Chat and Dashboard") || (name instanceof RegExp && name.test("Swap "))) {
    const dashboard = pane.locator(".chat-dashboard-menu").filter({ visible: true });
    if (await dashboard.isVisible()) {
      await selectMenuItem(await openChatDashboardMenu(pane), /^Swap /);
    } else {
      await button(side, "Panel position").click();
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
      await button(host, "Close pane").click();
      await host.waitFor({ state: "hidden" });
      return;
    }
    await menu.getByRole("menuitem", { name: "View", exact: true }).click();
  }
  await selectMenuItem(menu, name);
}
