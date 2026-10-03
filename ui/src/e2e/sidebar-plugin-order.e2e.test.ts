// Pointer and keyboard reordering share the sidebar's persisted ordering owners.
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI plugin sidebar order mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

async function captureUiProof(page: Page, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page.screenshot({ animations: "disabled", path: path.join(suite.artifactDir, fileName) });
  }
}

suite.define(() => {
  it("reorders plugin sidebar tabs and keeps the order after reload", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1200 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionGroups: ["Alpha", "Beta"],
      sessions: [
        { key: "agent:main:main", label: "Main" },
        { key: "agent:main:alpha", label: "Alpha task", category: "Alpha" },
        { key: "agent:main:beta", label: "Beta task", category: "Beta" },
      ],
      controlUiTabs: [
        { id: "reports/daily", label: "Reports", pluginId: "reports", icon: "plug" },
        { id: "birdclaw", label: "Birdclaw", pluginId: "birdclaw", icon: "bird" },
        { id: "workboard", label: "Workboard", pluginId: "workboard", icon: "kanban" },
      ],
    });
    try {
      await page.goto(suite.server.baseUrl + "chat");
      const sidebar = page.locator("openclaw-app-sidebar:visible");
      const row = (key: string) => sidebar.locator('[data-sidebar-entry="' + key + '"]');
      await row("plugin:workboard/workboard").waitFor();
      await captureUiProof(page, "plugin-drag-initial.png");
      for (const key of [
        "plugin:reports/reports/daily",
        "plugin:birdclaw/birdclaw",
        "plugin:workboard/workboard",
      ]) {
        expect(await row(key).getAttribute("draggable")).toBe("true");
      }
      await row("plugin:workboard/workboard").dragTo(row("route:cron"), {
        targetPosition: { x: 50, y: 2 },
      });
      await row("plugin:birdclaw/birdclaw").dragTo(row("plugin:workboard/workboard"), {
        targetPosition: { x: 50, y: 2 },
      });
      await row("plugin:reports/reports/daily").dragTo(row("plugin:birdclaw/birdclaw"), {
        targetPosition: { x: 50, y: 2 },
      });
      const keys = () =>
        sidebar
          .locator("[data-sidebar-entry]")
          .evaluateAll((rows) => rows.map((entry) => entry.getAttribute("data-sidebar-entry")));
      const expected = await keys();
      expect(
        expected.slice(
          expected.indexOf("plugin:reports/reports/daily"),
          expected.indexOf("route:cron") + 1,
        ),
      ).toEqual([
        "plugin:reports/reports/daily",
        "plugin:birdclaw/birdclaw",
        "plugin:workboard/workboard",
        "route:cron",
      ]);
      const reorderWorkboard = row("plugin:workboard/workboard").getByRole("button", {
        name: "Reorder Workboard",
        exact: true,
      });
      await reorderWorkboard.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Move up", exact: true }).press("Enter");
      const movedUp = [...expected];
      const workboardIndex = movedUp.indexOf("plugin:workboard/workboard");
      [movedUp[workboardIndex - 1], movedUp[workboardIndex]] = [
        movedUp[workboardIndex]!,
        movedUp[workboardIndex - 1]!,
      ];
      await expect.poll(keys).toEqual(movedUp);
      await expect
        .poll(() => reorderWorkboard.evaluate((element) => document.activeElement === element))
        .toBe(true);
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Move down", exact: true }).press("Enter");
      await expect.poll(keys).toEqual(expected);

      const reorderBeta = sidebar.getByRole("button", { name: "Reorder Beta", exact: true });
      await reorderBeta.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Move up", exact: true }).press("Enter");
      const sectionOrder = () =>
        sidebar
          .locator('[data-session-section^="category:"]')
          .evaluateAll((sections) =>
            sections.map((section) => section.getAttribute("data-session-section")),
          );
      await expect.poll(sectionOrder).toEqual(["category:Beta", "category:Alpha"]);
      expect((await gateway.waitForRequest("sessions.groups.put")).params).toMatchObject({
        names: ["Beta", "Alpha"],
      });
      await expect
        .poll(() => reorderBeta.evaluate((element) => document.activeElement === element))
        .toBe(true);
      await page.reload();
      await row("plugin:workboard/workboard").waitFor();
      await expect.poll(keys).toEqual(expected);
      await expect.poll(sectionOrder).toEqual(["category:Beta", "category:Alpha"]);
      await captureUiProof(page, "plugin-drag-reloaded.png");
    } finally {
      await context.close();
    }
  });

  it("shows page reorder grips only for keyboard focus", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      sessionGroups: ["Alpha", "Beta"],
      sessions: [
        { key: "agent:main:main", label: "Main" },
        { key: "agent:main:alpha", label: "Alpha task", category: "Alpha" },
        { key: "agent:main:beta", label: "Beta task", category: "Beta" },
      ],
    });
    try {
      await page.goto(suite.server.baseUrl + "chat");
      const sidebar = page.locator("openclaw-app-sidebar:visible");
      const pageRows = sidebar.locator(".sidebar-zone-entry:has(> .nav-item)");
      const agentsLink = sidebar.getByRole("link", { name: "Agents", exact: true });
      const agentsRow = pageRows.filter({
        has: page.getByRole("link", { name: "Agents", exact: true }),
      });
      await agentsRow.waitFor();
      const grip = (row: typeof agentsRow) =>
        row.evaluate((element) => {
          const link = element.querySelector(".nav-item")!.getBoundingClientRect();
          const menu = element.querySelector(".sidebar-reorder-trigger")!.getBoundingClientRect();
          return {
            linkWidth: link.width,
            menuWidth: menu.width,
            rowWidth: element.getBoundingClientRect().width,
          };
        });

      await agentsLink.hover();
      const hovered = await grip(agentsRow);
      expect(hovered.menuWidth).toBeLessThanOrEqual(1);
      expect(hovered.linkWidth).toBeCloseTo(hovered.rowWidth, 1);
      // Screen readers still reach the menu while it is visually hidden.
      await expect
        .poll(() => agentsRow.getByRole("button", { name: "Reorder Agents", exact: true }).count())
        .toBe(1);
      await captureUiProof(page, "page-reorder-pointer-hover.png");

      const keys = () =>
        sidebar
          .locator("[data-sidebar-entry]")
          .evaluateAll((rows) => rows.map((entry) => entry.getAttribute("data-sidebar-entry")));
      const before = await keys();
      await agentsLink.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect
        .poll(() => agentsLink.evaluate((link) => link.matches(":focus-visible")))
        .toBe(true);
      const focused = await grip(agentsRow);
      expect(focused.menuWidth).toBeGreaterThanOrEqual(24);
      expect(focused.linkWidth).toBeCloseTo(hovered.linkWidth, 1);
      await captureUiProof(page, "page-reorder-keyboard-focus.png");

      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Move down", exact: true }).press("Enter");
      const agentsKey = await agentsRow.getAttribute("data-sidebar-entry");
      const moved = [...before];
      const index = moved.indexOf(agentsKey);
      [moved[index], moved[index + 1]] = [moved[index + 1]!, moved[index]!];
      await expect.poll(keys).toEqual(moved);

      const sectionHead = sidebar.locator(
        '[data-session-section="category:Alpha"] .sidebar-recent-sessions__head',
      );
      await sectionHead.hover();
      await expect
        .poll(() =>
          sectionHead
            .locator(".sidebar-reorder-trigger")
            .evaluate((trigger) => getComputedStyle(trigger).opacity),
        )
        .toBe("1");
    } finally {
      await context.close();
    }
  });
});
