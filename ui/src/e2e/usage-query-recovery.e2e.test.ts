import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Usage failed date query attribution",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps failed date-query totals attributed to their successful source", async () => {
    const artifacts = createControlUiE2eArtifactDir("usage-query-recovery");
    const context = await suite.browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      viewport: { width: 1440, height: 1100 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const totals = {
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      totalCost: 1,
      inputCost: 1,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    const sessions = (date: string) => ({
      updatedAt: Date.now(),
      startDate: date,
      endDate: date,
      totals,
      sessions: [
        { key: "agent:main:query-proof", agentId: "main", label: "QA usage row", usage: totals },
      ],
      aggregates: {
        messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
      },
    });
    const cost = (date: string) => ({
      updatedAt: Date.now(),
      days: 1,
      totals,
      daily: [{ date, ...totals }],
    });
    try {
      await page.clock.setFixedTime(new Date("2026-08-07T12:00:00Z"));
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.usage": sessions("2026-08-07"),
          "usage.cost": cost("2026-08-07"),
          "usage.status": {
            updatedAt: Date.now(),
            providers: [{ provider: "openai", displayName: "QA Provider Plan", windows: [] }],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}usage`);
      const range = page.locator(".cost-window-range-label");
      const value = page.locator(".cost-window-card--range .cost-window-card__value");
      const refresh = page
        .locator("openclaw-usage-page")
        .getByRole("button", { name: "Refresh", exact: true });
      await expect.poll(() => value.textContent()).toMatch(/\$1\.00/);
      const originalRange = (await range.textContent())!.trim();
      const originalValue = (await value.textContent())!.trim();
      await page.screenshot({ path: path.join(artifacts, "initial.png"), fullPage: true });

      await gateway.deferNext("usage.cost");
      await refresh.click();
      await expect.poll(async () => (await gateway.getRequests("usage.cost")).length).toBe(2);
      await gateway.rejectDeferred("usage.cost", {
        code: "UNAVAILABLE",
        message: "QA cost temporarily unavailable",
      });
      await page.getByText("QA cost temporarily unavailable", { exact: true }).waitFor();
      expect((await range.textContent())!.trim()).toBe(originalRange);
      expect((await value.textContent())!.trim()).toBe(originalValue);
      await page.getByText("QA Provider Plan", { exact: true }).waitFor();

      await gateway.deferNext("usage.cost");
      const dates = page.locator("input.usage-date-input");
      await dates.nth(0).fill("2026-07-01");
      await dates.nth(1).fill("2026-07-01");
      await dates.nth(1).press("Tab");
      await expect.poll(async () => (await gateway.getRequests("usage.cost")).length).toBe(3);
      await gateway.rejectDeferred("usage.cost", {
        code: "UNAVAILABLE",
        message: "QA cost temporarily unavailable",
      });
      await page.getByText("QA cost temporarily unavailable", { exact: true }).waitFor();
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      await page.getByText("QA Provider Plan", { exact: true }).waitFor();
      const failedRange = (await range.count()) ? await range.textContent() : null;
      const failedValue = (await value.count()) ? await value.textContent() : null;
      await page.screenshot({ path: path.join(artifacts, "failed-date.png"), fullPage: true });
      if (await page.locator(".cost-window-analysis").count()) {
        await page.locator(".cost-window-analysis").scrollIntoViewIfNeeded();
      }
      await page.screenshot({ path: path.join(artifacts, "failed-summary.png") });
      await writeFile(
        path.join(artifacts, "observed.json"),
        JSON.stringify(
          {
            originalRange,
            originalValue,
            failedRange,
            failedValue,
            requests: await gateway.getRequests("usage.cost"),
          },
          null,
          2,
        ),
      );
      if (failedValue && /\d/.test(failedValue)) {
        expect.soft(failedRange?.trim()).toBe(originalRange);
        expect.soft(failedValue.trim()).toBe(originalValue);
      }
      expect(await page.locator(".usage-empty-state").count()).toBe(0);

      await gateway.setMethodResponse("sessions.usage", sessions("2026-07-01"));
      await gateway.setMethodResponse("usage.cost", cost("2026-07-01"));
      await refresh.click();
      await expect.poll(() => value.textContent()).toMatch(/\$1\.00/);
      expect((await range.textContent())!.trim()).not.toBe(originalRange);
      expect(await page.locator(".usage-callout.danger").count()).toBe(0);
      await page.screenshot({ path: path.join(artifacts, "recovered.png"), fullPage: true });
      await page.locator(".cost-window-analysis").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifacts, "recovered-summary.png") });
    } finally {
      await context.close();
    }
  });
});
