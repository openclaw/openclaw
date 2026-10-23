import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway as installMockGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Usage selected-session details" });

suite.define(() => {
  it("counts assistant invocations and refreshes selected usage details", async () => {
    const date = "2026-08-20";
    const start = Date.parse(`${date}T12:00:00Z`);
    const totals = {
      input: 300,
      output: 60,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 360,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    const tools = {
      totalCalls: 3,
      uniqueTools: 2,
      tools: [
        { name: "read", count: 2 },
        { name: "exec", count: 1 },
      ],
    };
    const messages = { total: 3, user: 0, assistant: 3, toolCalls: 3, toolResults: 2, errors: 0 };
    const points = [start, start + 2000, start + 4000].map((timestamp, index) => ({
      timestamp,
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: 0,
      cumulativeTokens: 120 * (index + 1),
      cumulativeCost: 0,
    }));
    const usageAt = (updatedAt: number, usageTotals = totals, assistant = 3) => ({
      updatedAt,
      startDate: date,
      endDate: date,
      sessions: [
        {
          key: "agent:main:tool-count",
          label: "Review two files",
          agentId: "main",
          updatedAt,
          usage: {
            ...usageTotals,
            activityDates: [date],
            toolUsage: tools,
            messageCounts: { ...messages, total: assistant, assistant },
          },
        },
      ],
      totals: usageTotals,
      aggregates: {
        messages,
        tools,
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
        costDaily: [{ date, ...usageTotals }],
      },
    });
    const logs = (
      [
        [0, "assistant", "[Tool: read]\n[Tool: read]"],
        [500, "toolResult", "[Tool: read]\n[Tool Result]\nFirst file"],
        [1000, "toolResult", "[Tool: read]\n[Tool Result]\nSecond file"],
        [2000, "assistant", "Both files reviewed."],
        [4000, "assistant", "[Tool: exec]"],
      ] as const
    ).map(([offset, role, content]) => ({ timestamp: start + offset, role, content }));
    await suite.withPage(
      {
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 1000 },
      },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date(start + 5000));
        const scenario = {
          methodResponses: {
            "sessions.usage": usageAt(start + 5000),
            "usage.status": { updatedAt: start + 5000, providers: [] },
            "sessions.usage.timeseries": { points },
            "sessions.usage.logs": { logs },
          },
        };
        const gateway = await installMockGateway(page, scenario);
        await page.goto(`${suite.server.baseUrl}usage`);
        await page.getByRole("button", { name: "Review two files", exact: true }).click();
        await gateway.waitForRequest("sessions.usage.timeseries");
        await gateway.waitForRequest("sessions.usage.logs");
        const panel = page.locator(".session-detail-panel");
        const handle = panel.locator(".chart-handle-right");
        await handle.waitFor({ state: "visible" });
        const count = panel.locator(".session-summary-value").nth(1);
        await expect.poll(() => count.textContent()).toBe("3");
        await handle.scrollIntoViewIfNeeded();
        const handleBox = await handle.boundingBox();
        const chartBox = await panel.locator(".timeseries-svg").boundingBox();
        expect(handleBox).not.toBeNull();
        expect(chartBox).not.toBeNull();
        if (!handleBox || !chartBox) {
          throw new Error("Timeline drag handles did not render");
        }
        const y = handleBox.y + handleBox.height / 2;
        await page.mouse.move(handleBox.x + handleBox.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(chartBox.x + (chartBox.width * (30 + 366 / 2)) / 400, y, {
          steps: 8,
        });
        await page.mouse.up();
        await panel.locator(".session-detail-indicator").waitFor({ state: "visible" });
        await expect.poll(() => panel.locator(".session-log-entry").count()).toBe(4);
        await expect.poll(() => count.textContent()).toBe("2");
        const readRow = panel.locator(".usage-list-item").filter({ hasText: "read" });
        expect(await readRow.locator(".usage-list-value").first().textContent()).toBe("2");
        expect(await panel.locator(".session-log-tools-pill").first().textContent()).toContain(
          "read × 2",
        );
        await panel.getByRole("button", { name: "Reset", exact: true }).click();
        await expect.poll(() => panel.locator(".session-detail-indicator").count()).toBe(0);
        await expect.poll(() => panel.locator(".session-log-entry").count()).toBe(5);
        await expect.poll(() => count.textContent()).toBe("3");

        const refreshedTotals = { ...totals, input: 400, output: 80, totalTokens: 480 };
        const latestReply = "The newly completed reply is included after Refresh.";
        await page.clock.setFixedTime(new Date(start + 7000));
        await gateway.setMethodResponse(
          "sessions.usage",
          usageAt(start + 7000, refreshedTotals, 4),
        );
        await gateway.setMethodResponse("sessions.usage.timeseries", {
          points: [...points, { ...points[2]!, timestamp: start + 6000, cumulativeTokens: 480 }],
        });
        await gateway.setMethodResponse("sessions.usage.logs", {
          logs: [...logs, { timestamp: start + 6000, role: "assistant", content: latestReply }],
        });
        const detailMethods = ["sessions.usage.timeseries", "sessions.usage.logs"] as const;
        const previousDetailRequests = await Promise.all(
          detailMethods.map(
            async (method) =>
              (await gateway.getRequests(method, { key: "agent:main:tool-count" })).length,
          ),
        );
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect
          .poll(() => panel.locator(".session-detail-stats").textContent())
          .toContain("480");
        const readDetails = async () => ({
          timeline: await panel.locator(".timeseries-summary").textContent(),
          conversation: await panel.locator(".session-log-content").allTextContents(),
        });
        await expect.poll(readDetails).toMatchObject({
          timeline: expect.stringContaining("480"),
          conversation: expect.arrayContaining([latestReply]),
        });
        for (const [index, method] of detailMethods.entries()) {
          const requests = await gateway.getRequests(method, { key: "agent:main:tool-count" });
          expect(requests).toHaveLength(previousDetailRequests[index]! + 1);
          expect(requests.at(-1)?.params).toMatchObject({
            key: "agent:main:tool-count",
          });
        }
      },
    );
  });
});
