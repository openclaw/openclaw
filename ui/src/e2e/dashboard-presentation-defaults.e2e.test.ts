import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { UiSettings } from "../app/settings.ts";
import { openChatDashboardMenu, selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "shared dashboard presentation defaults" });
const key = "agent:main:dashboard:9a1b2c3d-1234-4567-8901-234567890abc";
const sessionId = "dashboard-presentation-session";
const defaultAction = '[data-value="dashboard-default"]';
const defaultStatus = '[data-menu-status="dashboard-default"]';
async function openDashboard(page: Page) {
  const gateway = await installMockGateway(page, {
    sessionKey: key,
    sessions: [
      {
        key,
        agentId: "main",
        sessionId,
        kind: "direct",
        displayName: "Shared dashboard",
        boardFace: "dashboard",
        boardPresentation: "split",
        updatedAt: Date.now(),
      },
    ],
    operatorScopes: ["operator.read", "operator.write"],
    featureMethods: [
      "board.get",
      "chat.metadata",
      "chat.startup",
      "sessions.patch",
      "sessions.list",
      "sessions.describe",
      "sessions.resolve",
      "sessions.subscribe",
    ],
    methodResponses: {
      "board.get": {
        sessionKey: key,
        revision: 1,
        tabs: [{ tabId: "main", title: "Overview", position: 0, chatDock: "right" }],
        widgets: [],
      },
    },
  });
  const url = new URL(controlUiSessionUrl(suite.server.baseUrl, key, "dashboard"));
  url.searchParams.set("dashboard", "expanded");
  await page.goto(url.href);
  await page.locator("openclaw-board-view").waitFor();
  return gateway;
}

async function openDefaultAction(page: Page) {
  const menu = await openChatDashboardMenu(page);
  const action = menu.locator(defaultAction);
  await action.waitFor({ state: "visible" });
  return action;
}

async function saveDefault(page: Page, gateway: MockGatewayControls) {
  await selectChatLayoutAction(page, "Use current view as default");
  const saved = await gateway.waitForRequest("sessions.patch", {
    match: { boardPresentation: "expanded" },
  });
  expect(saved.params).toMatchObject({
    key,
    agentId: "main",
    expectedSessionId: sessionId,
    boardPresentation: "expanded",
  });
  const message = page.getByText("Dashboard default saved for future opens.", { exact: true });
  await message.waitFor();
  return message;
}

async function presentationOverride(page: Page) {
  return await page.evaluate(
    ({ storageKey, sessionKey }) => {
      const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Partial<UiSettings>;
      return settings.sidebarSessionLayouts?.[sessionKey]?.dashboardPresentationOverride;
    },
    { storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl), sessionKey: key },
  );
}

suite.define(() => {
  it("offers the same Dashboard options action on mobile without persisting deep-link intent", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await openDashboard(page);
      const chat = page.locator(".sidebar-region__primary");
      await chat.waitFor({ state: "visible" });
      await page.locator(".chat-mobile-host openclaw-board-view").waitFor();
      expect(await presentationOverride(page)).toBeUndefined();
      await selectChatLayoutAction(page, "Focus");
      await page
        .locator(".chat-mobile-host__header")
        .getByRole("button", { name: "Restore", exact: true })
        .waitFor();
      expect(await presentationOverride(page)).toBeUndefined();
      await selectChatLayoutAction(page, "Restore split");
      await page
        .locator(".chat-mobile-host__header")
        .getByRole("button", { name: "Expand Side panel", exact: true })
        .waitFor();
      // Mobile keeps Chat beside its sheet; the deep link still owns desktop presentation.
      await page.setViewportSize({ width: 1440, height: 1000 });
      await chat.waitFor({ state: "hidden" });
      expect(await presentationOverride(page)).toBeUndefined();
      await page.setViewportSize({ width: 390, height: 844 });
      await chat.waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Dashboard options", exact: true }).waitFor();
      await openDefaultAction(page);
      expect(
        await page
          .getByRole("menuitem", {
            name: /^(Swap Chat and Dashboard|Expand Dashboard|Restore split)$/,
          })
          .count(),
      ).toBe(0);
      const savedMessage = await saveDefault(page, gateway);
      const savedToast = page.getByRole("status").filter({ has: savedMessage });
      await savedToast.getByRole("button", { name: "Dismiss", exact: true }).click();
      await savedToast.waitFor({ state: "hidden" });
      await expect.poll(() => page.locator(defaultAction).count()).toBe(0);
      const savedTrigger = page.getByRole("button", { name: "Dashboard options", exact: true });
      await savedTrigger.focus();
      await savedTrigger.press("ArrowDown");
      const savedMenu = page.getByRole("menu", { name: "Dashboard options", exact: true });
      await savedMenu.waitFor();
      await savedMenu.locator(defaultStatus).waitFor({ state: "visible" });
      expect(await savedMenu.getByRole("menuitem").getAttribute("aria-disabled")).toBe("true");
      expect(await savedMenu.locator(defaultStatus).textContent()).toContain(
        "This is the default view",
      );
      expect(
        (await savedTrigger.evaluate((element) => element === document.activeElement)) ||
          (await savedMenu.evaluate((element) => element.contains(document.activeElement))),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await savedMenu.waitFor({ state: "hidden" });
      expect(await savedTrigger.evaluate((element) => element === document.activeElement)).toBe(
        true,
      );
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      expect(await presentationOverride(page)).toBeUndefined();
    });
  });
});
