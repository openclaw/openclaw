import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForMobileSidebarDrawerOpen } from "./session-management.test-support.ts";
import {
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
  await sidebar.getByRole("menuitem", { name: "Pin", exact: true }).click();
  const pinned = sidebar.locator('[data-pinned-agent="main"]');
  const link = pinned.getByRole("link", { name: "Harbor", exact: true });
  await link.waitFor({ state: "visible" });
  await expectFocused(link);
  await link.hover();
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
  await unpin.click();
  await pinned.waitFor({ state: "detached" });
  await expectFocused(row);
  await row.click({ button: "right" });
  const pin = sidebar.getByRole("menuitem", { name: "Pin", exact: true });
  await pin.waitFor();
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
