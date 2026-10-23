import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { SessionsUsageResult } from "../../../src/shared/usage-types.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway as installMockGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Usage calendar boundaries" });
const emptyTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};
const emptyMessages = { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 };
function aggregates(
  messages = emptyMessages,
  costDaily: SessionsUsageResult["aggregates"]["costDaily"] = [],
) {
  return {
    messages,
    costDaily,
    tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
    byModel: [],
    byProvider: [],
    byAgent: [],
    byChannel: [],
    daily: [],
  };
}
async function selectLocalDate(page: Page, date: string) {
  await page.getByRole("combobox", { name: "Time zone", exact: true }).selectOption("local");
  const inputs = await page.locator(".usage-date-input").all();
  expect(inputs).toHaveLength(2);
  for (const input of inputs) {
    await input.fill(date);
    await input.press("Tab");
  }
}
async function expectUsageRange(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  date: string,
  timeZone?: string,
) {
  await expect
    .poll(async () => (await gateway.getRequests("sessions.usage")).at(-1)?.params)
    .toMatchObject({
      startDate: date,
      endDate: date,
      ...(timeZone ? { mode: "specific", timeZone } : { mode: "utc" }),
    });
}

suite.define(() => {
  it.each([
    ["Asia/Shanghai", "2026-09-13T16:30:00Z", "2026-09-13", "2026-09-14"],
    ["America/Los_Angeles", "2026-09-14T02:30:00Z", "2026-09-14", "2026-09-13"],
    ["Asia/Shanghai", "2026-09-14T04:30:00Z", "2026-09-14", "2026-09-14"],
  ])(
    "uses the selected calendar for date presets in %s at %s",
    async (timezoneId, instant, utcDate, localDate) => {
      const updatedAt = Date.parse(instant);
      const totals = {
        ...emptyTotals,
        input: 1200,
        totalTokens: 1200,
        totalCost: 0.12,
        inputCost: 0.12,
      };
      const messages = { ...emptyMessages, total: 1, assistant: 1 };
      const calendars = [
        { timeZone: "utc", date: utcDate, mode: "utc" },
        { timeZone: "local", date: localDate, mode: "specific" },
      ] as const;
      await suite.withPage(
        {
          locale: "en-US",
          timezoneId,
          serviceWorkers: "block",
          viewport: { width: 1440, height: 1000 },
        },
        async ({ page }) => {
          await page.clock.setFixedTime(new Date(instant));
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "agents.list": {
                defaultId: "main",
                mainKey: "main",
                scope: "per-sender",
                agents: [
                  { id: "main", name: "OpenClaw" },
                  { id: "research", name: "Research" },
                ],
              },
              "sessions.usage": {
                cases: [
                  ...calendars.map(({ date, mode }) => ({
                    match: { endDate: date, mode },
                    response: {
                      updatedAt,
                      startDate: date,
                      endDate: date,
                      sessions: [
                        {
                          key: "agent:main:calendar-boundary",
                          label: "Calendar-boundary session",
                          agentId: "main",
                          updatedAt,
                          usage: { ...totals, activityDates: [date], messageCounts: messages },
                        },
                      ],
                      totals,
                      aggregates: aggregates(messages, [{ date, ...totals }]),
                    },
                  })),
                  {
                    match: {},
                    response: {
                      updatedAt,
                      sessions: [],
                      totals: emptyTotals,
                      aggregates: aggregates(messages),
                    },
                  },
                ],
              },
              "usage.status": { updatedAt, providers: [] },
            },
          });
          await page.goto(`${suite.server.baseUrl}usage`);
          const agentScope = page.locator(".agent-scope-control openclaw-agent-select");
          await agentScope.locator(".agent-select__trigger").click();
          await agentScope
            .locator(".agent-select__option[data-agent-option]")
            .filter({ hasText: "All agents" })
            .click();
          await gateway.waitForRequest("sessions.usage", { match: { agentScope: "all" } });
          for (const { timeZone, date, mode } of calendars) {
            const initialRequests = (await gateway.getRequests("sessions.usage")).length;
            await page
              .getByRole("combobox", { name: "Time zone", exact: true })
              .selectOption(timeZone);
            await gateway.waitForRequest("sessions.usage", { after: initialRequests });
            for (const [label, days] of [
              ["Today", 1],
              ["7d", 7],
              ["30d", 30],
              ["90d", 90],
              ["1y", 365],
              ["All", null],
            ] as const) {
              const startDate =
                days === null
                  ? "1970-01-01"
                  : new Date(Date.parse(`${date}T12:00:00Z`) - (days - 1) * 86_400_000)
                      .toISOString()
                      .slice(0, 10);
              const requestsBefore = (await gateway.getRequests("sessions.usage")).length;
              await page
                .locator(".usage-presets")
                .getByRole("button", { name: label, exact: true })
                .click();
              await page.clock.fastForward(400);
              const request = await gateway.waitForRequest("sessions.usage", {
                after: requestsBefore,
              });
              await expect
                .poll(() => page.locator(".usage-page .usage-loading-spinner").count())
                .toBe(0);
              expect(request.params).toMatchObject({ startDate, endDate: date, mode });
              const inputs = await page.locator(".usage-date-input").all();
              expect(await Promise.all(inputs.map((input) => input.inputValue()))).toEqual([
                startDate,
                date,
              ]);
              await expect
                .poll(() => page.locator(".usage-metric-badge strong").first().textContent())
                .toBe("1.2K");
              if (label === "7d") {
                expect(
                  (await page.locator(".cost-window__label").allTextContents()).map((windowLabel) =>
                    windowLabel.trim(),
                  ),
                ).toContain("Today");
              }
            }
          }
        },
      );
    },
  );

  it("keeps hour filtering responsive across the repeated local hour", async () => {
    const date = "2026-11-01";
    const start = Date.parse("2026-11-01T08:30:00Z");
    const end = Date.parse("2026-11-01T10:30:00Z");
    const activeAt = Date.parse("2026-11-01T10:15:00Z");
    const totals = { ...emptyTotals, input: 100, totalTokens: 100 };
    const messages = { ...emptyMessages, total: 1, user: 1 };
    await suite.withPage(
      { locale: "en-US", timezoneId: "America/Los_Angeles", serviceWorkers: "block" },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date(end));
        expect(
          await page.evaluate(() =>
            ["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"].map((timestamp) => {
              const value = new Date(timestamp);
              return [value.getHours(), value.getTimezoneOffset()];
            }),
          ),
        ).toEqual([
          [1, 420],
          [1, 480],
        ]);
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt: end,
              startDate: date,
              endDate: date,
              sessions: [
                {
                  key: "agent:main:timestamped-no-tokens",
                  label: "Messages without token usage",
                  agentId: "main",
                  updatedAt: end,
                  usage: {
                    ...emptyTotals,
                    firstActivity: start,
                    lastActivity: end,
                    activityDates: [date],
                    messageCounts: { ...messages, total: 2, user: 2 },
                    utcQuarterHourMessageCounts: [34, 42].map((quarterIndex) =>
                      Object.assign({ date, quarterIndex }, messages),
                    ),
                    // Timestamped messages without model usage still produce zero-token buckets.
                    utcQuarterHourTokenUsage: [34, 42].map((quarterIndex) =>
                      Object.assign({ date, quarterIndex }, emptyTotals),
                    ),
                  },
                },
                {
                  key: "agent:main:after-repeated-hour",
                  label: "After the repeated hour",
                  agentId: "main",
                  updatedAt: activeAt,
                  usage: {
                    ...totals,
                    firstActivity: activeAt,
                    lastActivity: activeAt,
                    activityDates: [date],
                    messageCounts: { ...messages, user: 0, assistant: 1 },
                    utcQuarterHourMessageCounts: [
                      { date, quarterIndex: 41, ...messages, user: 0, assistant: 1 },
                    ],
                    utcQuarterHourTokenUsage: [{ date, quarterIndex: 41, ...totals }],
                  },
                },
              ],
              totals,
              aggregates: aggregates({ ...messages, total: 3, user: 2, assistant: 1 }, [
                { date, ...totals },
              ]),
            },
            "usage.status": { updatedAt: end, providers: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        await selectLocalDate(page, date);
        await expectUsageRange(gateway, date, "America/Los_Angeles");
        const titles = page.locator(".session-bar-title");
        const cells = page.locator(".usage-hour-cell");
        const unfilteredTitles = ["Messages without token usage", "After the repeated hour"];
        await expect.poll(() => titles.allTextContents()).toEqual(unfilteredTitles);
        await expect.poll(() => cells.count()).toBe(24);
        await expect.poll(() => cells.nth(2).getAttribute("aria-label")).toBe("2:00 · 100 tokens");
        await cells.nth(2).click();
        await expect.poll(() => cells.nth(2).getAttribute("aria-pressed")).toBe("true");
        await expect.poll(() => titles.allTextContents()).toEqual(unfilteredTitles);
        await cells.nth(2).click();
        await cells.nth(3).click();
        await expect.poll(() => titles.allTextContents()).toEqual([]);
        await page.getByRole("button", { name: "Remove hours filter", exact: true }).click();
        await expect.poll(() => titles.allTextContents()).toEqual(unfilteredTitles);
        await expect.poll(() => cells.nth(2).getAttribute("aria-pressed")).toBe("false");
      },
    );
  });

  it("ends a local range at the next calendar midnight after a skipped midnight", async () => {
    const date = "2026-09-06";
    const updatedAt = Date.parse("2026-09-06T15:00:00Z");
    const totals = { ...emptyTotals, input: 100, totalTokens: 100 };
    const points = [
      "2026-09-06T03:59:59.999Z",
      "2026-09-06T04:00:00.000Z",
      "2026-09-07T02:59:59.999Z",
      "2026-09-07T03:00:00.000Z",
      "2026-09-07T03:30:00.000Z",
    ].map((timestamp) => ({
      timestamp: Date.parse(timestamp),
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: 0,
      cumulativeTokens: 100,
      cumulativeCost: 0,
    }));
    await suite.withPage(
      { locale: "en-US", timezoneId: "America/Santiago", serviceWorkers: "block" },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date(updatedAt));
        // Thread-local TZ cannot configure native Date; the browser context owns this zone.
        expect(
          await page.evaluate(() => {
            const start = new Date(2026, 8, 6);
            const end = new Date(2026, 8, 7);
            return [
              start.getHours(),
              end.getHours(),
              (end.getTime() - start.getTime()) / 3_600_000,
            ];
          }),
        ).toEqual([1, 0, 23]);
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt,
              startDate: date,
              endDate: date,
              sessions: [
                {
                  key: "agent:main:skipped-midnight",
                  label: "Skipped midnight",
                  agentId: "main",
                  updatedAt,
                  usage: { ...totals, activityDates: [date] },
                },
              ],
              totals,
              aggregates: aggregates(emptyMessages, [{ date, ...totals }]),
            },
            "usage.status": { updatedAt, providers: [] },
            "sessions.usage.timeseries": { points },
            "sessions.usage.logs": { logs: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        await selectLocalDate(page, date);
        await expectUsageRange(gateway, date, "America/Santiago");
        await page.getByRole("button", { name: "Skipped midnight", exact: true }).click();
        await gateway.waitForRequest("sessions.usage.timeseries");
        const bars = page.locator(".session-detail-panel .ts-bar");
        await expect.poll(() => bars.count()).toBe(2);
        const barLabels = () =>
          bars.evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("aria-label")),
          );
        const expectedBar = (time: string) =>
          `Sep 6, ${time} · 100 tokens · Out 0 · In 100 · CW 0 · CR 0`;
        await expect.poll(barLabels).toEqual([expectedBar("01:00 AM"), expectedBar("11:59 PM")]);
        await page.getByRole("combobox", { name: "Time zone", exact: true }).selectOption("utc");
        await expectUsageRange(gateway, date);
        await page.getByRole("button", { name: "Skipped midnight", exact: true }).click();
        await expect.poll(barLabels).toEqual([expectedBar("03:59 AM"), expectedBar("04:00 AM")]);
      },
    );
  });
});
