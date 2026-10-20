import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import type { UiSettings } from "../app/settings.ts";
import {
  closeChatLayoutMenu,
  openChatLayoutMenu as openLayoutMenu,
  selectChatLayoutAction,
} from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  reconnectMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import type { ControlUiSessionFixture } from "../test-helpers/control-ui-session-fixtures.ts";
import { focusChatSidePanel } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "shared dashboard presentation defaults" });
const key = "agent:main:dashboard:9a1b2c3d-1234-4567-8901-234567890abc";
const sessionId = "dashboard-presentation-session";
const defaultAction = '[data-value="dashboard-default"]';
const defaultStatus = '[data-menu-status="dashboard-default"]';
const withDesktop = (run: Parameters<typeof suite.withPage>[1]) =>
  suite.withPage({ viewport: { width: 1440, height: 1000 } }, run);
const capture = (page: Page, name: string) =>
  page.screenshot({ path: path.join(suite.artifactDir, name + ".png") });

async function expectDefaultStatus(page: Page) {
  const status = (await openLayoutMenu(page)).locator(defaultStatus);
  await status.waitFor({ state: "visible" });
  expect(await status.textContent()).toContain("This is the default view");
  return status;
}

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
    personalPin?: boolean;
  } = {},
) {
  if (options.personalPin) {
    await page.addInitScript(
      ({ storageKey, entry }) => {
        const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
        localStorage.setItem(storageKey, JSON.stringify({ ...settings, railShortcuts: [entry] }));
      },
      {
        storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        entry: `session:${key}`,
      },
    );
  }
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

async function openDefaultAction(page: Page) {
  const menu = await openLayoutMenu(page);
  const action = menu.locator(defaultAction);
  await action.waitFor({ state: "visible" });
  return action;
}

async function saveDefault(page: Page, gateway: MockGatewayControls, openingFace = false) {
  await selectChatLayoutAction(page, "Use current view as default");
  const saved = await gateway.waitForRequest(
    "sessions.patch",
    openingFace ? undefined : { match: { boardPresentation: "expanded" } },
  );
  expect(saved.params).toMatchObject({
    key,
    agentId: "main",
    expectedSessionId: sessionId,
    boardPresentation: "expanded",
    ...(openingFace ? { boardFace: "dashboard" } : {}),
  });
  const message = page.getByText("Dashboard default saved for future opens.", { exact: true });
  await message.waitFor();
  return message;
}

async function expectLayout(page: Page, presentation: "split" | "expanded") {
  await page.locator("openclaw-board-view").waitFor({ state: "visible" });
  await page.locator(".sidebar-region__primary").waitFor({
    state: presentation === "expanded" ? "hidden" : "visible",
  });
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
    await withDesktop(async ({ page }) => {
      const gateway = await openDashboard(page, "expanded", {
        face: "chat",
        sessionRow: { ...row("expanded"), boardFace: undefined },
        personalPin: true,
      });
      const sidebarLink = page.locator(`.sidebar-rail [data-sidebar-entry="session:${key}"] a`);
      await sidebarLink.waitFor();
      expect(await sidebarLink.getAttribute("href")).toContain("/chat/main/");
      await page.keyboard.press("Control+Shift+Alt+G");
      await page.locator("openclaw-board-view").waitFor({ state: "visible" });
      const chat = page.locator('openclaw-chat-pane[aria-hidden="false"] .sidebar-region__primary');
      await chat.waitFor({ state: "hidden" });
      const menu = await openLayoutMenu(page);
      await menu.locator(`${defaultAction}, ${defaultStatus}`).waitFor({ state: "visible" });
      await capture(page, "07-unset-opening-view-menu");
      expect(await menu.locator(defaultStatus).count()).toBe(0);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await saveDefault(page, gateway, true);
      await expect.poll(() => sidebarLink.getAttribute("href")).toContain("/dashboard/main/");
      const savedMenu = await openLayoutMenu(page);
      await savedMenu.locator(defaultStatus).waitFor({ state: "visible" });
      await capture(page, "08-opening-default-saved");
      await closeChatLayoutMenu(page);
      // This fixture can read Sessions but does not advertise Home or session creation.
      await page.locator('[data-navigation-view="pages"]').click();
      await page
        .locator(".sidebar-pages")
        .getByRole("link", { name: "Sessions", exact: true })
        .click();
      await page.waitForURL((url) => url.pathname === "/sessions");
      await page.locator("openclaw-board-view").waitFor({ state: "hidden" });
      await sidebarLink.click();
      await page.waitForURL((url) => url.pathname.includes("/dashboard/main/"));
      await page.locator("openclaw-board-view").waitFor({ state: "visible" });
      await chat.waitFor({ state: "hidden" });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);

      const savedRow = await gateway.getSessionRow(key);
      await withDesktop(async ({ page: reader }) => {
        const readerGateway = await openDashboard(reader, "expanded", {
          face: "chat",
          readOnly: true,
          sessionRow: savedRow,
          personalPin: true,
        });
        const readerLink = reader.locator(`.sidebar-rail [data-sidebar-entry="session:${key}"] a`);
        await readerLink.waitFor();
        expect(await readerLink.getAttribute("href")).toContain("/dashboard/main/");
        await readerLink.click();
        await reader.waitForURL((url) => url.pathname.includes("/dashboard/main/"));
        await expectLayout(reader, "expanded");
        expect(await presentationOverride(reader)).toBeUndefined();
        expect(await readerGateway.getRequests("sessions.patch")).toHaveLength(0);
        await capture(reader, "09-fresh-sidebar-open");
      });
    });
  });

  it.each(["split", "expanded"] as const)(
    "opens the shared %s default through the real keyboard shortcut",
    async (presentation) => {
      await withDesktop(async ({ page }) => {
        await openDashboard(page, presentation, { face: "chat" });
        await page.keyboard.press("Control+Shift+Alt+G");
        await expectLayout(page, presentation);
        expect(await presentationOverride(page)).toBeNull();
      });
    },
  );

  it.each(["split", "expanded"] as const)(
    "keeps the agent-requested %s view through actual face-change navigation",
    async (requested) => {
      const shared = requested === "expanded" ? "split" : "expanded";
      await withDesktop(async ({ page }) => {
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
        await expectLayout(page, requested);
        expect(await presentationOverride(page)).toBeUndefined();
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key, "chat"));
        await page.locator(".chat-pane__header").waitFor();
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key, "dashboard"));
        await expectLayout(page, shared);
        expect(await presentationOverride(page)).toBeUndefined();
      });
    },
  );

  it("saves a conditional shared default while a fresh reader can override it locally", async () => {
    await withDesktop(async ({ page }) => {
      const gateway = await openDashboard(page, "split");
      const chat = page.locator(".sidebar-region__primary");
      await chat.waitFor({ state: "visible" });
      expect(await page.locator(defaultAction).count()).toBe(0);
      const matchingStatus = await expectDefaultStatus(page);
      expect(await matchingStatus.textContent()).toContain(
        "Used when anyone opens this dashboard. Personal layout choices still apply.",
      );
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await capture(page, "00-current-default-menu");
      await closeChatLayoutMenu(page);

      await focusChatSidePanel(page);
      await chat.waitFor({ state: "hidden" });
      const action = await openDefaultAction(page);
      expect(await action.textContent()).toContain("Use current view as default");
      expect(await page.locator(defaultStatus).count()).toBe(0);
      await capture(page, "01-different-default-menu");
      await saveDefault(page, gateway);
      await expect.poll(() => page.locator(defaultAction).count()).toBe(0);
      await expectDefaultStatus(page);
      await capture(page, "02-default-saved");
      await closeChatLayoutMenu(page);

      await withDesktop(async ({ page: reader }) => {
        const readerGateway = await openDashboard(reader, "expanded", { readOnly: true });
        const readerChat = reader.locator(".sidebar-region__primary");
        await readerChat.waitFor({ state: "hidden" });
        expect(await presentationOverride(reader)).toBeUndefined();
        await reconnectMockGateway(reader, readerGateway);
        await expectLayout(reader, "expanded");
        await expectDefaultStatus(reader);
        expect(await reader.locator(defaultAction).count()).toBe(0);
        await capture(reader, "03-new-viewer-inherits");
        await closeChatLayoutMenu(reader);
        await selectChatLayoutAction(reader, "Restore split");
        await readerChat.waitFor({ state: "visible" });
        expect(await presentationOverride(reader)).toBe("split");
        expect(await reader.locator(defaultAction).count()).toBe(0);
        expect(await reader.locator(defaultStatus).count()).toBe(0);
        expect(
          await readerGateway.getRequests("sessions.patch", { boardPresentation: "split" }),
        ).toHaveLength(0);
        await reader.reload();
        await expectLayout(reader, "split");
        expect(await presentationOverride(reader)).toBe("split");
        await capture(reader, "04-reader-override-reloaded");
      });

      await selectChatLayoutAction(page, "Restore split");
      await chat.waitFor({ state: "visible" });
      await selectChatLayoutAction(page, "Focus");
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
      await expectLayout(page, "split");
      expect(await presentationOverride(page)).toBeNull();
    });
  });

  it("offers the same conditional action in the compact menu without persisting deep-link intent", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await openDashboard(page, "split", { expandedLink: true });
      await page.locator(".sidebar-region__primary").waitFor({ state: "hidden" });
      expect(await presentationOverride(page)).toBeUndefined();
      await openDefaultAction(page);
      await capture(page, "05-compact-default-menu");
      const savedMessage = await saveDefault(page, gateway);
      const savedToast = page.getByRole("status").filter({ has: savedMessage });
      await savedToast.getByRole("button", { name: "Dismiss", exact: true }).click();
      await savedToast.waitFor({ state: "hidden" });
      await expect.poll(() => page.locator(defaultAction).count()).toBe(0);
      await expectDefaultStatus(page);
      await capture(page, "06-compact-default-saved");
      expect(await presentationOverride(page)).toBeUndefined();
    });
  });
});
