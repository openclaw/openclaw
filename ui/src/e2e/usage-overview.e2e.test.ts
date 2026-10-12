import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../../src/infra/session-cost-usage-totals.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Usage server overview",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps all-session totals while paging and requests filters before rendering their results", async () => {
    const artifacts = createControlUiE2eArtifactDir("usage-overview");
    await suite.withPage(
      {
        locale: "en-US",
        timezoneId: "UTC",
        viewport: { width: 1440, height: 1100 },
        serviceWorkers: "block",
      },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date("2026-08-07T12:00:00Z"));
        const totals = {
          ...createEmptyCostUsageTotals(),
          input: 125000,
          totalTokens: 125000,
          inputCost: 125,
          totalCost: 125,
        };
        const messages = {
          total: 2500,
          user: 1250,
          assistant: 1250,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        };
        const session = (index: number, label = `Session ${index + 1}`) => ({
          key: `agent:main:overview-${index}`,
          label,
          agentId: "main",
          sessionId: `session-${index}`,
          updatedAt: 2000 - index,
          usage: {
            ...createEmptyCostUsageTotals(),
            durationMs: index === 0 ? 60000 : 0,
            messageCounts: {
              total: 2,
              user: 1,
              assistant: 1,
              toolCalls: 0,
              toolResults: 0,
              errors: 0,
            },
            input: 100,
            totalTokens: 100,
            totalCost: 0.1,
            inputCost: 0.1,
          },
        });
        const response = (offset = 0, filtered = false) => ({
          updatedAt: Date.parse("2026-08-07T12:00:00Z"),
          startDate: "2026-07-09",
          endDate: "2026-08-07",
          totals: filtered ? session(1201).usage : totals,
          sessions: filtered
            ? [session(1201, "Needle outside the first thousand")]
            : Array.from({ length: 50 }, (_, index) => session(offset + index)),
          aggregates: {
            messages: filtered ? session(1201).usage.messageCounts : messages,
            tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
            byModel: [],
            byProvider: [],
            byAgent: [{ agentId: "main", totals: filtered ? session(1201).usage : totals }],
            byChannel: [],
            daily: [],
            costDaily: [{ date: "2026-08-07", ...(filtered ? session(1201).usage : totals) }],
          },
          overview: {
            offset,
            limit: 50,
            total: filtered ? 1 : 1250,
            unfilteredSessionCount: 1250,
            selectedSessionCount: filtered ? 1 : 1250,
            selectedRowCount: filtered ? 1 : 1250,
            tableSessionCount: filtered ? 1 : 1250,
            tableTotals: { tokens: filtered ? 100 : 125000, cost: filtered ? 0.1 : 125, errors: 0 },
            queryWarnings: [],
            durationMs: filtered ? 0 : 60000,
            durationCount: filtered ? 0 : 1,
            hourTokens: Array.from({ length: 24 }, (_, hour) =>
              hour === 12 ? (filtered ? 100 : 125000) : 0,
            ),
            weekdayTokens: [0, 0, 0, 0, 0, filtered ? 100 : 125000, 0],
            hourlyMessages: Array(24).fill(0),
            hourlyErrors: Array(24).fill(0),
            hasTimelineData: true,
            filterOptions: { agent: ["main"], channel: [], provider: [], model: [], tool: [] },
          },
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": {
              cases: [
                { match: { query: "label:Needle" }, response: response(0, true) },
                { match: { offset: 50 }, response: response(50) },
                { match: {}, response: response() },
              ],
            },
            "usage.status": { updatedAt: 1, providers: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        const rows = page.locator(".sessions-card .session-bar-title");
        await expect.poll(() => rows.count()).toBe(50);
        await expect
          .poll(() => page.locator(".session-bar-meta").first().textContent())
          .toContain("msgs:2");
        await expect
          .poll(() => page.locator(".session-bar-meta").first().textContent())
          .toContain("dur:1m");
        const fullHeight = await page
          .locator(".usage-page")
          .evaluate((element) => Math.ceil(element.scrollHeight) + 400);
        const fullFrame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".usage-page"),
          [page.locator(".usage-header"), rows.first(), page.locator(".data-table-pagination")],
          {
            animations: "disabled",
            viewport: { width: 1440, height: fullHeight },
          },
        );
        await writeFile(path.join(artifacts, "overview-and-sessions.png"), fullFrame.png);
        await page.setViewportSize({ width: 1440, height: 1100 });
        await expect
          .poll(() => page.locator(".usage-metric-badge").allTextContents())
          .toEqual(["125.0K Tokens", "$125.00 Cost", "1250 sessions"]);
        expect((await gateway.getRequests("sessions.usage"))[0]?.params).toMatchObject({
          projection: "overview",
          limit: 50,
        });
        const capture = async (name: string, card = rows.first()) => {
          const frame = await takeControlUiScreenshotFrame(page, card, [card], {
            animations: "disabled",
            scrollTo: card,
          });
          await writeFile(path.join(artifacts, `${name}.png`), frame.png);
        };
        await capture("summary", page.locator(".usage-header"));
        await capture("first-page");
        await capture("pagination", page.locator(".data-table-pagination"));
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect.poll(() => rows.first().textContent()).toBe("Session 51");
        expect((await gateway.getRequests("sessions.usage")).at(-1)?.params).toMatchObject({
          projection: "overview",
          offset: 50,
        });
        await expect
          .poll(() => page.locator(".usage-metric-badge").allTextContents())
          .toEqual(["125.0K Tokens", "$125.00 Cost", "1250 sessions"]);
        await capture("second-page");
        await page.locator(".usage-query-input").fill("label:Needle");
        await page.locator(".usage-query-input").press("Enter");
        await expect
          .poll(() => rows.allTextContents())
          .toEqual(["Needle outside the first thousand"]);
        const filtered = (await gateway.getRequests("sessions.usage")).at(-1)?.params;
        expect(filtered).toMatchObject({ projection: "overview", query: "label:Needle" });
        expect(filtered).not.toHaveProperty("offset");
        await expect
          .poll(() => page.locator(".usage-metric-badge").allTextContents())
          .toEqual(["100 Tokens", "$0.10 Cost", "1 session"]);
        await capture("filtered-beyond-thousand");
        await writeFile(
          path.join(artifacts, "requests.json"),
          JSON.stringify(await gateway.getRequests("sessions.usage"), null, 2),
        );
      },
    );
  });
});
