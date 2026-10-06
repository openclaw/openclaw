import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Usage session layout" });

suite.define(() => {
  it.each([
    { scenario: "narrow entry", initialWidth: 390, width: 390, stacked: true },
    { scenario: "desktop resized to narrow", initialWidth: 1440, width: 390, stacked: true },
    { scenario: "narrow desktop container", initialWidth: 1280, width: 1280, stacked: true },
    { scenario: "wide desktop", initialWidth: 1440, width: 1440, stacked: false },
  ])("keeps the session list and selection controls usable on $scenario", async (cell) => {
    await suite.withPage(
      {
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
        viewport: { width: cell.initialWidth, height: 900 },
      },
      async ({ page }) => {
        const date = "2026-09-18";
        const updatedAt = Date.parse(`${date}T12:00:00Z`);
        await page.clock.setFixedTime(new Date(updatedAt));
        const totals = {
          input: 1200,
          output: 300,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1500,
          totalCost: 0.04,
          inputCost: 0.03,
          outputCost: 0.01,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 0,
        };
        const sessions = ["First session", "Second session"].map((label, index) => ({
          key: `agent:main:usage-layout-${index}`,
          label,
          agentId: "main",
          updatedAt,
          usage: { ...totals, activityDates: [date] },
        }));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt,
              startDate: date,
              endDate: date,
              sessions,
              totals,
              aggregates: {
                messages: {
                  total: 0,
                  user: 0,
                  assistant: 0,
                  toolCalls: 0,
                  toolResults: 0,
                  errors: 0,
                },
                tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
                byModel: [],
                byProvider: [],
                byAgent: [],
                byChannel: [],
                daily: [],
              },
            },
            "usage.cost": { updatedAt, days: 1, daily: [{ date, ...totals }], totals },
            "usage.status": { updatedAt, providers: [] },
            "sessions.usage.timeseries": { points: [] },
            "sessions.usage.logs": { logs: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        const card = page.locator(".sessions-card");
        const list = card.locator(".session-bars").first();
        const firstSession = list.getByRole("button", { name: "First session", exact: true });
        await firstSession.click();
        await gateway.waitForRequest("sessions.usage.timeseries");
        await gateway.waitForRequest("sessions.usage.logs");
        await page.locator(".session-detail-panel").waitFor();
        await page.setViewportSize({ width: cell.width, height: 900 });
        const columns = page.locator(".usage-grid-column");
        await expect
          .poll(async () => {
            const listBounds = await columns.nth(0).boundingBox();
            const detail = await columns.nth(1).boundingBox();
            if (!listBounds || !detail) {
              return false;
            }
            return cell.stacked
              ? detail.y >= listBounds.y + listBounds.height &&
                  Math.abs(listBounds.width - detail.width) < 1
              : detail.x >= listBounds.x + listBounds.width &&
                  Math.abs(listBounds.y - detail.y) < 1;
          })
          .toBe(true);
        await card.getByRole("button", { name: "Clear Selection", exact: true }).click();
        await expect.poll(() => columns.count()).toBe(1);
        await expect.poll(() => firstSession.getAttribute("aria-pressed")).toBe("false");

        await firstSession.click();
        await list
          .getByRole("button", { name: "Second session", exact: true })
          .click({ modifiers: ["Shift"] });
        await expect.poll(() => columns.count()).toBe(1);
        await expect.poll(() => list.locator('[aria-pressed="true"]').count()).toBe(2);
        await card.getByRole("button", { name: "Clear Selection", exact: true }).click();
        await expect.poll(() => list.locator('[aria-pressed="true"]').count()).toBe(0);
      },
    );
  });
});
