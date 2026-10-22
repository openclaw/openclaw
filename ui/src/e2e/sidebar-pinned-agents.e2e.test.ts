import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForMobileSidebarDrawerOpen } from "./session-management.test-support.ts";
import {
  expectCounts,
  expectFocused,
  expectHorizontalBounds,
  seedSidebarSettings,
  sidebarSession,
  style,
} from "./sidebar-contract.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Pinned agent sidebar" });
const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
    { id: "research", name: "Research and competitive intelligence", identity: { emoji: "🔬" } },
  ],
};
const assistantReply =
  "The release notes are ready for review. The next step is checking the examples.";

async function checkSavedPins({ page }: { page: Page }) {
  const legacyKey = "agent:research:legacy-notes";
  await seedSidebarSettings(page, suite.server.baseUrl, {
    sidebarAgentsMode: "roster",
    pinnedAgentIds: ["main"],
    railShortcuts: [`session:${legacyKey}`],
  });
  await installMockGateway(page, {
    sessionKey: "agent:main:main",
    sessions: [
      sessionRow("agent:main:main", "Harbor chat", 30),
      sessionRow(legacyKey, "Legacy notes", 20),
    ],
    methodResponses: { "agents.list": agentsList },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForControlUiRoute(page, { routeId: "chat" });
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.locator('[data-pinned-agent="main"]').waitFor();
  await sidebar.getByRole("link", { name: "Legacy notes", exact: true }).waitFor();
  expect(await sidebar.locator('[data-agent-group="research"]').count()).toBe(1);

  await page.goto(`${suite.server.baseUrl}sessions`);
  await waitForControlUiRoute(page, { routeId: "sessions" });
  await page.locator(".session-data-row").filter({ hasText: "Legacy notes" }).waitFor();
  expect(await sidebar.locator('[data-pinned-agent="main"]').count()).toBe(1);
}

async function checkAccessiblePins(page: Page, width: number) {
  await seedSidebarSettings(page, suite.server.baseUrl, { sidebarAgentsMode: "roster" });
  await installMockGateway(page, {
    sessions: [
      sidebarSession("agent:main:main", undefined, {
        agentId: "main",
        isMain: true,
        updatedAt: 30,
        lastMessagePreview: "A newer user question",
        lastAssistantMessage: { text: assistantReply, timestamp: 20 },
      }),
      sidebarSession("agent:main:working-session", undefined, {
        agentId: "main",
        isMain: false,
        updatedAt: 25,
        hasActiveRun: true,
        status: "running",
      }),
    ],
    methodResponses: {
      "agents.list": agentsList,
      "chat.startup": {
        agentsList,
        messages: [],
        metadata: { models: [] },
        sessionId: "main-session",
        thinkingLevel: null,
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForControlUiRoute(page, { routeId: "chat" });
  const drawerToggle = navigationDrawerToggle(page);
  if (await page.locator(".shell--mobile-nav").count()) {
    await drawerToggle.press("Enter");
    await waitForMobileSidebarDrawerOpen(page);
  }
  const sidebar = page.locator("openclaw-app-sidebar:visible");
  const header = sidebar.locator('[data-agent-group="main"] .sidebar-agent-roster__header');
  const row = header.locator(".sidebar-agent-roster__row");
  const menu = header.getByRole("button", { name: "Options for Harbor" });
  await row.waitFor({ state: "visible" });
  expect(await row.getAttribute("title")).toBeNull();
  expect(await header.locator("a").count()).toBe(1);
  // Agent metadata renders before the separate session-activity query can settle.
  await expect
    .poll(() => header.locator(".sidebar-agent-roster__avatar .session-glyph__ring").count())
    .toBe(1);
  await expectCounts(sidebar, {
    "[data-agent-collapse]": 0,
    ".sidebar-agent-roster__signals .sidebar-child-session-toggle__count": 0,
    ".sidebar-agent-roster__signals .session-glyph__ring": 0,
    "[data-agent-group] .sidebar-recent-session": 0,
  });
  const longNameRow = sidebar.locator('[data-agent-group="research"] .sidebar-agent-roster__row');
  await page.mouse.move(-1, -1);
  const restingPadding = await style(longNameRow, "padding-inline-end");
  await longNameRow.hover();
  expect(restingPadding).toBe(width === 390 ? "32px" : "0px");
  expect(await style(longNameRow, "padding-inline-end")).toBe("32px");
  for (const state of ["hover", "focus"] as const) {
    if (state === "hover") {
      await row.hover();
    } else {
      await page.mouse.move(-1, -1);
      await menu.focus();
    }
    expect(await style(header.locator(".sidebar-agent-roster__actions"), "opacity")).toBe("1");
    const rowBounds = (await row.boundingBox())!;
    const bounds = (await menu.boundingBox())!;
    const headerBounds = (await header.boundingBox())!;
    expect(bounds.y + bounds.height / 2).toBeCloseTo(rowBounds.y + rowBounds.height / 2, 1);
    expect(bounds.x).toBeGreaterThanOrEqual(headerBounds.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(headerBounds.x + headerBounds.width);
    expect(bounds.y).toBeGreaterThanOrEqual(headerBounds.y);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(headerBounds.y + headerBounds.height);
    if (state === "focus") {
      expect(await style(menu, "outline-style")).toBe("solid");
    }
  }
  await menu.press("ArrowDown");
  const viewSessions = sidebar.getByRole("menuitem", { name: "Sessions", exact: true });
  const settings = sidebar.getByRole("menuitem", { name: "Settings", exact: true });
  const deleteAgent = sidebar.getByRole("menuitem", { name: "Delete", exact: true });
  expect(await sidebar.getByRole("menuitem", { name: "Create new session" }).count()).toBe(0);
  for (const item of [viewSessions, settings, deleteAgent]) {
    await expectCounts(item, { svg: 1 });
    // Menu refreshes retain the row but can replace its icon before a child locator evaluates.
    expect(
      await item.evaluate((element) => {
        const icon = element.querySelector("svg");
        return icon ? getComputedStyle(icon).getPropertyValue("width") : null;
      }),
    ).toBe("16px");
  }
  expect(await sidebar.getByRole("menuitem", { name: "Collapse others" }).count()).toBe(0);
  const menuLabels = await sidebar.getByRole("menuitem").allTextContents();
  expect(menuLabels.findIndex((label) => label.trim() === "Settings") + 1).toBe(
    menuLabels.findIndex((label) => label.trim() === "Delete"),
  );
  expect(await deleteAgent.getAttribute("data-variant")).toBe("danger");
  await sidebar.getByRole("menuitem", { name: "Pin", exact: true }).click();
  const pinned = sidebar.locator('[data-pinned-agent="main"]');
  const link = pinned.getByRole("link", { name: "Harbor", exact: true });
  await link.waitFor({ state: "visible" });
  await expectFocused(link);
  await expectCounts(sidebar, { '[data-agent-group="main"]': 0 });
  expect(await sidebar.locator('[data-agent-group="research"]').isVisible()).toBe(true);
  await expectCounts(pinned, {
    ".sidebar-agent-roster__preview": 0,
    ".sidebar-pinned-agent__avatar .session-glyph__ring": 1,
  });
  await link.hover();
  expect(await pinned.getByRole("button").count()).toBe(0);
  expect(await style(sidebar.locator(".sidebar-pinned-agents"), "border-bottom-style")).toBe(
    "none",
  );
  const card = pinned.locator(".tooltip-surface[popover]:popover-open");
  const content = pinned.locator(".sidebar-pinned-agent__card");
  for (const state of ["hover", "focus"] as const) {
    await page.mouse.move(-1, -1);
    await link.evaluate((element) => element.blur());
    await expect.poll(() => card.count()).toBe(0);
    if (state === "hover") {
      await link.hover();
    } else {
      // Tooltips open for keyboard focus, so reach the link by tabbing.
      await link.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expectFocused(link);
    }
    await card.waitFor({ state: "visible" });
    await content.waitFor({ state: "visible" });
    expect(await content.textContent()).toContain(assistantReply);
    expect(await content.textContent()).not.toContain("A newer user question");
    expect(await link.getAttribute("aria-describedby")).toBeTruthy();
    await expectHorizontalBounds(card, width);
    await page.keyboard.press("Escape");
    await expect.poll(() => card.count()).toBe(0);
    expect(await sidebar.isVisible()).toBe(true);
  }
  await link.focus();
  await page.keyboard.press("Shift+F10");
  const unpin = sidebar.getByRole("menuitem", { name: "Unpin", exact: true });
  await unpin.waitFor();
  expect(
    (await sidebar.getByRole("menuitem").allTextContents()).map((label) => label.trim()),
  ).toEqual(["Unpin", "Sessions", "Settings", "Delete"]);
  await unpin.click();
  await expectCounts(sidebar, { "[data-pinned-agent]": 0, '[data-agent-group="main"]': 1 });
  await expectFocused(row);
  await row.click({ button: "right" });
  const pin = sidebar.getByRole("menuitem", { name: "Pin", exact: true });
  await pin.waitFor();
  expect(await pin.locator("svg").evaluate((icon) => getComputedStyle(icon).fill)).toBe("none");
  if (width === 1440) {
    await captureSidebarUiProof(suite, page, "agent-roster-pin-menu-after.png", sidebar);
  }
  await page.keyboard.press("Escape");
  await expect.poll(() => pin.count()).toBe(0);
  await sidebar
    .locator('[data-agent-group="research"]')
    .getByRole("button", { name: "Options for Research and competitive intelligence" })
    .press("ArrowDown");
  await sidebar.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await waitForControlUiRoute(page, {
    routeId: "agents",
    pathname: "/settings/agents/research",
  });
}

suite.define(() => {
  it("loads saved agent and session pins alongside existing session rows", () =>
    suite.withPage({ locale: "en-US", viewport: { width: 1280, height: 900 } }, checkSavedPins));
  it("creates a Claw from a pinned agent row in its existing main chat", async () => {
    await suite.withPage(
      { locale: "en-US", colorScheme: "dark", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        await page.addInitScript(
          (key) =>
            localStorage.setItem(
              key,
              JSON.stringify({ sidebarAgentsMode: "roster", pinnedAgentIds: ["main"] }),
            ),
          settingsKey,
        );
        const config = { gateway: { controlUi: { experimental: { claws: true } } } };
        const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          sessions: [sessionRow("agent:main:main", "Harbor chat", 30)],
          featureMethods: ["claws.drafts.create", "chat.send"],
          methodResponses: {
            "agents.list": agentsList,
            "config.get": {
              config,
              sourceConfig: config,
              resolved: config,
              raw: JSON.stringify(config),
              hash: "pinned-claw-creator-config",
              path: "/tmp/openclaw-pinned-claw-creator.json",
              valid: true,
              issues: [],
            },
            "chat.startup": {
              agentsList,
              messages: [],
              metadata: { models: [] },
              sessionId: "main-session",
              thinkingLevel: null,
            },
            "claws.drafts.create": {
              draftId,
              prompt:
                "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
            },
            "chat.send": { status: "started", runId: "claw-authoring-run" },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        const sidebar = page.locator("openclaw-app-sidebar:visible");
        const pinnedAgent = sidebar.locator('[data-pinned-agent="main"]');
        await pinnedAgent.waitFor();
        await page.mouse.move(-1, -1);
        await captureSidebarUiProof(suite, page, "claw-creator-pinned-before.png", pinnedAgent);

        await pinnedAgent.hover();
        expect(await pinnedAgent.getByRole("button").count()).toBe(0);
        await pinnedAgent.getByRole("link", { name: "Harbor", exact: true }).click({
          button: "right",
        });
        const menu = sidebar.getByRole("menu", { name: "Options for Harbor" });
        const createClawItem = menu.getByRole("menuitem", { name: "Create Claw" });
        await createClawItem.waitFor();
        expect(
          (await menu.getByRole("menuitem").allTextContents()).map((label) => label.trim()),
        ).toEqual(["Unpin", "Sessions", "Create Claw", "Settings", "Delete"]);
        // The pinned state fills the pin glyph; the unpinned Pin action keeps its outline.
        expect(
          await menu
            .getByRole("menuitem", { name: "Unpin", exact: true })
            .locator("svg")
            .evaluate((icon) => getComputedStyle(icon).fill),
        ).not.toBe("none");
        await captureSidebarUiProof(suite, page, "claw-creator-pinned-menu-after.png", sidebar);

        await createClawItem.click();
        await gateway.waitForRequest("claws.drafts.create");
        await gateway.waitForRequest("chat.send");
        const createRequest = await gateway.getRequests("claws.drafts.create");
        expect(createRequest[0]?.params).toEqual({ agentId: "main" });
        const sendRequest = await gateway.getRequests("chat.send");
        expect(sendRequest[0]?.params).toMatchObject({
          sessionKey: "agent:main:main",
          message: "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
          workContext: {
            page: "claw-create",
            agentId: "main",
            sessionKey: "agent:main:main",
            detail: { draftId },
          },
          deliver: false,
        });
        expect(sendRequest[0]?.params).not.toHaveProperty("parentSessionKey");
        expect(await sidebar.locator('[data-pinned-agent="main"]').count()).toBe(1);
        await expect
          .poll(() =>
            page.evaluate((key) => {
              const value = JSON.parse(localStorage.getItem(key) ?? "{}");
              return value.pinnedAgentIds;
            }, settingsKey),
          )
          .toEqual(["main"]);
      },
    );
  });

  it.each([1440, 1366, 768, 390])(
    "keeps row actions and pinned cards accessible at %s px",
    (width) =>
      suite.withPage(
        {
          locale: "en-US",
          viewport: { width, height: width === 390 ? 844 : 900 },
          hasTouch: width === 390,
        },
        ({ page }) => checkAccessiblePins(page, width),
      ),
  );
});
