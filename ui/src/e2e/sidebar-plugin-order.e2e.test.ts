import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { isFocused } from "./sidebar-contract.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI plugin sidebar order mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

const reports = "plugin:reports/reports/daily";
const birdclaw = "plugin:birdclaw/birdclaw";
const workboard = "plugin:workboard/workboard";
const expected = [reports, birdclaw, workboard];

async function checkPluginOrder({ page }: { page: Page }) {
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
  await page.goto(suite.server.baseUrl + "chat");
  const sidebar = page.locator("openclaw-app-sidebar:visible");
  const rail = sidebar.locator(".sidebar-rail__pins");
  const row = (key: string) => rail.locator('[data-sidebar-entry="' + key + '"]');
  await sidebar.getByRole("button", { name: "Pages", exact: true }).click();
  const pages = sidebar.locator(".sidebar-pages");
  for (const key of expected) {
    const catalogRow = pages.locator(".sidebar-pages__entry").filter({
      has: page.locator('[data-sidebar-entry="' + key + '"]'),
    });
    await catalogRow.getByRole("button", { name: "Pin", exact: true }).click();
    await row(key).waitFor();
    expect(await catalogRow.getByRole("button", { name: "Unpin", exact: true }).count()).toBe(1);
    expect(await catalogRow.locator("a").isVisible()).toBe(true);
  }
  await sidebar.getByRole("button", { name: "Sessions", exact: true }).click();
  for (const key of expected) {
    expect(await row(key).getAttribute("draggable")).toBe("true");
  }
  const moveBefore = (source: string, target: string) =>
    row(source).dragTo(row(target), { targetPosition: { x: 18, y: 2 } });
  await moveBefore(workboard, reports);
  await moveBefore(birdclaw, workboard);
  await moveBefore(reports, birdclaw);
  const keys = () =>
    rail
      .locator("[data-sidebar-entry]")
      .evaluateAll((rows) => rows.map((entry) => entry.getAttribute("data-sidebar-entry")));
  expect(await keys()).toEqual(expected);
  const reorderWorkboard = row(workboard).getByRole("link", { name: "Workboard", exact: true });
  await reorderWorkboard.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Move up", exact: true }).press("Enter");
  await expect.poll(keys).toEqual([reports, workboard, birdclaw]);
  await expect.poll(() => isFocused(reorderWorkboard)).toBe(true);
  await reorderWorkboard.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move down", exact: true }).click();
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
  await expect.poll(() => isFocused(reorderBeta)).toBe(true);
  // This profileless fixture owns personal navigation in the Gateway-scoped browser mirror.
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await expect
    .poll(() =>
      page.evaluate((key) => {
        return JSON.parse(localStorage.getItem(key) ?? "{}").railShortcuts;
      }, settingsKey),
    )
    .toEqual(expected);
  expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
  await page.reload();
  await row(workboard).waitFor();
  await expect.poll(keys).toEqual(expected);
  await expect.poll(sectionOrder).toEqual(["category:Beta", "category:Alpha"]);
}

suite.define(() => {
  it("reorders plugin sidebar tabs and keeps the order after reload", () =>
    suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1200 } },
      checkPluginOrder,
    ));
});
