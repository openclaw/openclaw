import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import type { UiSettings } from "../app/settings.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  reconnectMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import type { ControlUiSessionFixture } from "../test-helpers/control-ui-session-fixtures.ts";
import { focusChatSidePanel } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "shared dashboard presentation defaults" });
const key = "agent:main:dashboard:9a1b2c3d-1234-4567-8901-234567890abc";
const sessionId = "dashboard-presentation-session";
const defaultAction = 'wa-dropdown-item[value="quick:layout:dashboard-default"]';
const defaultStatus = '[data-menu-status="dashboard-default"]';

function row(presentation: "split" | "expanded") {
  return {
    key,
    agentId: "main",
    sessionId,
    kind: "direct",
    displayName: "Shared dashboard",
    boardFace: "dashboard",
    boardPresentation: presentation,
    updatedAt: Date.now(),
  } satisfies GatewaySessionRow;
}

async function openDashboard(
  page: Page,
  presentation: "split" | "expanded",
  options: {
    readOnly?: boolean;
    expandedLink?: boolean;
    face?: "chat" | "dashboard";
    sessionRow?: ControlUiSessionFixture;
  } = {},
) {
  const gateway = await installMockGateway(page, {
    sessionKey: key,
    sessions: [options.sessionRow ?? row(presentation)],
    operatorScopes: options.readOnly ? ["operator.read"] : ["operator.read", "operator.write"],
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
  const url = new URL(controlUiSessionUrl(suite.server.baseUrl, key, options.face ?? "dashboard"));
  if (options.expandedLink) {
    url.searchParams.set("dashboard", "expanded");
  }
  await page.goto(url.href);
  if (options.face === "chat") {
    await page.locator(".chat-pane__header").waitFor();
    await gateway.waitForRequest("board.get");
  } else {
    await page.locator("openclaw-board-view").waitFor();
  }
  return gateway;
}

async function waitForLayoutMenuClosed(page: Page) {
  await page.waitForFunction(() => {
    const dropdown = document.querySelector("openclaw-chat-header-session-menu wa-dropdown");
    const popup = dropdown?.shadowRoot?.querySelector("wa-popup");
    return (
      (!dropdown || Reflect.get(dropdown, "open") !== true) &&
      (!popup || !Reflect.get(popup, "active"))
    );
  });
}

async function openLayoutMenu(page: Page) {
  // A save closes the popup asynchronously; finish that close before reopening it.
  await waitForLayoutMenuClosed(page);
  await page.locator(".chat-header-session-menu__trigger").click();
  const menu = page.locator("openclaw-chat-header-session-menu");
  const layout = menu.locator(".session-menu__text").filter({ hasText: /^Layout$/ });
  if ((await menu.locator("wa-dropdown.chat-header-session-menu--compact").count()) > 0) {
    await layout.click();
  } else {
    await layout.hover();
  }
  return menu;
}

async function openDefaultAction(page: Page) {
  const menu = await openLayoutMenu(page);
  const action = menu.locator(defaultAction);
  await action.waitFor({ state: "visible" });
  return action;
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
  it("saves the dashboard opening face together with its presentation and reopens from the sidebar", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await openDashboard(page, "expanded", {
        face: "chat",
        sessionRow: { ...row("expanded"), boardFace: undefined, pinned: true },
      });
      const sidebarLink = page.locator(
        `[data-sidebar-entry="session:${key}"] .sidebar-recent-session__link`,
      );
      await sidebarLink.waitFor();
      expect(await sidebarLink.getAttribute("href")).toContain("/chat/main/");
      await page.keyboard.press("Control+Shift+Alt+G");
      await page.locator("openclaw-board-view").waitFor({ state: "visible" });
      const chat = page.locator('openclaw-chat-pane[aria-hidden="false"] .sidebar-region__primary');
      await chat.waitFor({ state: "hidden" });
      const menu = await openLayoutMenu(page);
      await menu.locator(`${defaultAction}, ${defaultStatus}`).waitFor({ state: "visible" });
      await page.screenshot({
        path: path.join(suite.artifactDir, "07-unset-opening-view-menu.png"),
      });
      expect(await menu.locator(defaultStatus).count()).toBe(0);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await menu.locator(defaultAction).click();
      const saved = await gateway.waitForRequest("sessions.patch");
      expect(saved.params).toMatchObject({
        key,
        agentId: "main",
        expectedSessionId: sessionId,
        boardFace: "dashboard",
        boardPresentation: "expanded",
      });
      await page.getByText("Dashboard default saved for future opens.", { exact: true }).waitFor();
      await expect.poll(() => sidebarLink.getAttribute("href")).toContain("/dashboard/main/");
      const savedMenu = await openLayoutMenu(page);
      await savedMenu.locator(defaultStatus).waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(suite.artifactDir, "08-opening-default-saved.png") });
      await page.locator(".chat-header-session-menu__trigger").click();
      await waitForLayoutMenuClosed(page);
      await page.getByRole("link", { name: "Home", exact: true }).click();
      await page.locator("openclaw-board-view").waitFor({ state: "hidden" });
      await sidebarLink.click();
      await page.waitForURL((url) => url.pathname.includes("/dashboard/main/"));
      await page.locator("openclaw-board-view").waitFor({ state: "visible" });
      await chat.waitFor({ state: "hidden" });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);

      const savedRow = await gateway.getSessionRow(key);
      await suite.withPage(
        { viewport: { width: 1440, height: 1000 } },
        async ({ page: reader }) => {
          const readerGateway = await openDashboard(reader, "expanded", {
            face: "chat",
            readOnly: true,
            sessionRow: savedRow,
          });
          const readerLink = reader.locator(
            `[data-sidebar-entry="session:${key}"] .sidebar-recent-session__link`,
          );
          await readerLink.waitFor();
          expect(await readerLink.getAttribute("href")).toContain("/dashboard/main/");
          await readerLink.click();
          await reader.waitForURL((url) => url.pathname.includes("/dashboard/main/"));
          await reader.locator("openclaw-board-view").waitFor({ state: "visible" });
          await reader.locator(".sidebar-region__primary").waitFor({ state: "hidden" });
          expect(await presentationOverride(reader)).toBeUndefined();
          expect(await readerGateway.getRequests("sessions.patch")).toHaveLength(0);
          await reader.screenshot({
            path: path.join(suite.artifactDir, "09-fresh-sidebar-open.png"),
          });
        },
      );
    });
  });

  it.each(["split", "expanded"] as const)(
    "opens the shared %s default through the real keyboard shortcut",
    async (presentation) => {
      await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
        await openDashboard(page, presentation, { face: "chat" });
        await page.keyboard.press("Control+Shift+Alt+G");
        await page.locator("openclaw-board-view").waitFor({ state: "visible" });
        await page.locator(".sidebar-region__primary").waitFor({
          state: presentation === "expanded" ? "hidden" : "visible",
        });
        expect(await presentationOverride(page)).toBeNull();
      });
    },
  );

  it.each(["split", "expanded"] as const)(
    "keeps the agent-requested %s view through actual face-change navigation",
    async (requested) => {
      const shared = requested === "expanded" ? "split" : "expanded";
      await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
        const gateway = await openDashboard(page, shared, {
          face: "chat",
          sessionRow: { ...row(shared), boardFace: "chat" },
        });
        await gateway.emitGatewayEvent("board.command", {
          sessionKey: key,
          command: { kind: "set_chat_dock", dock: requested === "expanded" ? "hidden" : "right" },
        });
        // Navigation may replace the raw key with its friendly session slug.
        await expect.poll(() => new URL(page.url()).pathname).toContain("/dashboard/main/");
        await page.locator("openclaw-board-view").waitFor({ state: "visible" });
        const chat = page.locator(".sidebar-region__primary");
        await chat.waitFor({ state: requested === "expanded" ? "hidden" : "visible" });
        expect(await presentationOverride(page)).toBeUndefined();
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key, "chat"));
        await page.locator(".chat-pane__header").waitFor();
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key, "dashboard"));
        await page.locator("openclaw-board-view").waitFor({ state: "visible" });
        await chat.waitFor({ state: shared === "expanded" ? "hidden" : "visible" });
        expect(await presentationOverride(page)).toBeUndefined();
      });
    },
  );

  it("saves a conditional shared default while a fresh reader can override it locally", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await openDashboard(page, "split");
      const chat = page.locator(".sidebar-region__primary");
      await chat.waitFor({ state: "visible" });
      expect(await page.locator(defaultAction).count()).toBe(0);
      const matchingMenu = await openLayoutMenu(page);
      const matchingStatus = matchingMenu.locator(defaultStatus);
      await matchingStatus.waitFor({ state: "visible" });
      expect(await matchingStatus.textContent()).toContain("This is the default view");
      expect(await matchingStatus.textContent()).toContain(
        "Used when anyone opens this dashboard. Personal layout choices still apply.",
      );
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await page.screenshot({ path: path.join(suite.artifactDir, "00-current-default-menu.png") });
      await page.locator(".chat-header-session-menu__trigger").click();
      await waitForLayoutMenuClosed(page);

      await focusChatSidePanel(page);
      await chat.waitFor({ state: "hidden" });
      const action = await openDefaultAction(page);
      expect(await action.textContent()).toContain("Use current view as default");
      expect(await page.locator(defaultStatus).count()).toBe(0);
      await page.screenshot({
        path: path.join(suite.artifactDir, "01-different-default-menu.png"),
      });
      await action.click();
      const saved = await gateway.waitForRequest("sessions.patch", {
        match: { boardPresentation: "expanded" },
      });
      expect(saved.params).toMatchObject({
        key,
        agentId: "main",
        expectedSessionId: sessionId,
        boardPresentation: "expanded",
      });
      await page.getByText("Dashboard default saved for future opens.", { exact: true }).waitFor();
      await expect.poll(() => page.locator(defaultAction).count()).toBe(0);
      const savedMenu = await openLayoutMenu(page);
      await savedMenu.locator(defaultStatus).waitFor({ state: "visible" });
      expect(await savedMenu.locator(defaultStatus).textContent()).toContain(
        "This is the default view",
      );
      await page.screenshot({ path: path.join(suite.artifactDir, "02-default-saved.png") });
      await page.locator(".chat-header-session-menu__trigger").click();
      await waitForLayoutMenuClosed(page);

      await suite.withPage(
        { viewport: { width: 1440, height: 1000 } },
        async ({ page: reader }) => {
          const readerGateway = await openDashboard(reader, "expanded", { readOnly: true });
          const readerChat = reader.locator(".sidebar-region__primary");
          await readerChat.waitFor({ state: "hidden" });
          expect(await presentationOverride(reader)).toBeUndefined();
          await reconnectMockGateway(reader, readerGateway);
          await reader.locator("openclaw-board-view").waitFor({ state: "visible" });
          await readerChat.waitFor({ state: "hidden" });
          const readerMenu = await openLayoutMenu(reader);
          await readerMenu.locator(defaultStatus).waitFor({ state: "visible" });
          expect(await readerMenu.locator(defaultStatus).textContent()).toContain(
            "This is the default view",
          );
          expect(await reader.locator(defaultAction).count()).toBe(0);
          await reader.screenshot({
            path: path.join(suite.artifactDir, "03-new-viewer-inherits.png"),
          });
          await reader.locator(".chat-header-session-menu__trigger").click();
          await waitForLayoutMenuClosed(reader);
          await reader.getByRole("button", { name: "Restore split", exact: true }).click();
          await readerChat.waitFor({ state: "visible" });
          expect(await presentationOverride(reader)).toBe("split");
          expect(await reader.locator(defaultAction).count()).toBe(0);
          expect(await reader.locator(defaultStatus).count()).toBe(0);
          expect(
            await readerGateway.getRequests("sessions.patch", { boardPresentation: "split" }),
          ).toHaveLength(0);
          await reader.reload();
          await reader.locator("openclaw-board-view").waitFor();
          await readerChat.waitFor({ state: "visible" });
          expect(await presentationOverride(reader)).toBe("split");
          await reader.screenshot({
            path: path.join(suite.artifactDir, "04-reader-override-reloaded.png"),
          });
        },
      );

      await page.getByRole("button", { name: "Restore split", exact: true }).click();
      await chat.waitFor({ state: "visible" });
      await page
        .locator(".chat-pane__header")
        .getByRole("button", { name: "Focus", exact: true })
        .click();
      await chat.waitFor({ state: "hidden" });
      expect(await presentationOverride(page)).toBeNull();
      // The server changes while this browser still has the old roster cached.
      await gateway.setSessionsListResponse({
        ts: Date.now(),
        path: "",
        count: 1,
        defaults: { modelProvider: "openai", model: "gpt-4.1", contextTokens: null },
        sessions: [row("split")],
      });
      await page.reload();
      await page.locator("openclaw-board-view").waitFor();
      await chat.waitFor({ state: "visible" });
      expect(await presentationOverride(page)).toBeNull();
    });
  });

  it("offers the same conditional action in the compact menu without persisting deep-link intent", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await openDashboard(page, "split", { expandedLink: true });
      await page.locator(".sidebar-region__primary").waitFor({ state: "hidden" });
      expect(await presentationOverride(page)).toBeUndefined();
      const action = await openDefaultAction(page);
      await page.screenshot({ path: path.join(suite.artifactDir, "05-compact-default-menu.png") });
      await action.click();
      await gateway.waitForRequest("sessions.patch", { match: { boardPresentation: "expanded" } });
      await page.getByText("Dashboard default saved for future opens.", { exact: true }).waitFor();
      await expect.poll(() => page.locator(defaultAction).count()).toBe(0);
      const savedMenu = await openLayoutMenu(page);
      await savedMenu.locator(defaultStatus).waitFor({ state: "visible" });
      expect(await savedMenu.locator(defaultStatus).textContent()).toContain(
        "This is the default view",
      );
      await page.screenshot({ path: path.join(suite.artifactDir, "06-compact-default-saved.png") });
      expect(await presentationOverride(page)).toBeUndefined();
    });
  });
});
