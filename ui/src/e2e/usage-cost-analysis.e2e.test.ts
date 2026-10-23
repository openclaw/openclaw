import type { BrowserContextOptions, Locator } from "playwright";
import { expect, it } from "vitest";
import type { SessionUsageEntry } from "../../../src/shared/usage-types.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway as installMockGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI usage cost analysis mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const viewport = { height: 1_000, width: 1_440 };
const pageOptions: BrowserContextOptions = { locale: "en-US", serviceWorkers: "block", viewport };
const costMessages = {
  total: 40,
  user: 20,
  assistant: 20,
  toolCalls: 12,
  toolResults: 12,
  errors: 0,
};

const totals = {
  input: 1_200_000,
  output: 300_000,
  cacheRead: 2_400_000,
  cacheWrite: 100_000,
  totalTokens: 4_000_000,
  totalCost: 32,
  inputCost: 12,
  outputCost: 12,
  cacheReadCost: 6,
  cacheWriteCost: 2,
  missingCostEntries: 0,
};

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

function dayOffset(offset: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dailyEntry(offset: number, totalCost: number, totalTokens: number) {
  return {
    ...emptyTotals,
    date: dayOffset(offset),
    input: totalTokens,
    totalTokens,
    totalCost,
    inputCost: totalCost,
  };
}

const modelUsage = [
  { provider: "openai", model: "gpt-5.5", count: 30, totals: { ...totals, totalCost: 22 } },
  {
    provider: "anthropic",
    model: "claude-opus-4-6",
    count: 10,
    totals: { ...totals, totalCost: 10 },
  },
];

function providerHistory(
  provider: string,
  displayName: string,
  amount: number,
  category: string,
  rows: Array<[offset: number, amount: number, requests?: number]>,
  name: string,
) {
  return {
    provider,
    displayName,
    plan: "Admin API",
    windows: [],
    billing: [{ type: "spend", label: "30-day API spend", amount, unit: "USD" }],
    costHistory: {
      unit: "USD",
      periodDays: 30,
      daily: rows.map(([offset, dayAmount, requests]) => ({
        date: dayOffset(offset),
        amount: dayAmount,
        inputTokens: 1_000,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        outputTokens: 100,
        requests,
      })),
      models: [{ name, totalTokens: 1_000 }],
      categories: [{ name: category, amount }],
    },
  };
}

function expectPopover(surface: Locator, open: boolean) {
  return expect
    .poll(() => surface.evaluate((element) => element.matches(":popover-open")))
    .toBe(open);
}

function expectTexts(locator: Locator, expected: string[]) {
  return expect.poll(() => locator.allTextContents()).toEqual(expected);
}

function expectText(locator: Locator) {
  return expect.poll(() => locator.textContent());
}

async function trimmedTexts(locator: Locator) {
  return (await locator.allTextContents()).map((text) => text.trim());
}

function makeSession(
  key: string,
  label: string,
  updatedAt: number,
  usage: SessionUsageEntry["usage"],
  model: Pick<SessionUsageEntry, "model" | "modelProvider"> = {},
) {
  return { key, label, updatedAt, usage, agentId: "main", ...model };
}

function usageOnDay(date: string) {
  return {
    ...totals,
    activityDates: [date],
    dailyBreakdown: [{ ...totals, date, cost: totals.totalCost, tokens: totals.totalTokens }],
  };
}

function emptyUsageResponses() {
  const updatedAt = Date.now();
  const date = dayOffset(0);
  return {
    "sessions.usage": {
      updatedAt,
      startDate: date,
      endDate: date,
      sessions: [],
      totals: emptyTotals,
      aggregates: {
        messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
        costDaily: [],
      },
    },
  };
}

suite.define(() => {
  it.each([
    { timeZone: "utc", quarterIndex: 8 },
    { timeZone: "local", quarterIndex: 28 },
  ] as const)(
    "keeps historical $timeZone error-hour labels stable across today's DST gap",
    async ({ timeZone, quarterIndex }) => {
      const date = "2026-01-15";
      const updatedAt = Date.parse("2026-01-15T07:00:00Z");
      const usageTotals = { ...emptyTotals, output: 100, totalTokens: 100 };
      const messages = {
        total: 10,
        user: 5,
        assistant: 5,
        toolCalls: 0,
        toolResults: 0,
        errors: 5,
      };
      const empty = emptyUsageResponses();
      const match = {
        startDate: date,
        endDate: date,
        ...(timeZone === "utc"
          ? { mode: "utc" }
          : { mode: "specific", timeZone: "America/New_York" }),
      };
      await suite.withPage(
        {
          ...pageOptions,
          timezoneId: "America/New_York",
        },
        async ({ page }) => {
          await page.clock.setFixedTime(new Date("2026-03-07T17:00:00Z"));
          expect(
            await page.evaluate(() => [
              new Date("2026-01-15T07:00:00Z").getHours(),
              new Date("2026-03-08T07:00:00Z").getHours(),
            ]),
          ).toEqual([2, 3]);
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "sessions.usage": {
                cases: [
                  {
                    match,
                    response: {
                      ...empty["sessions.usage"],
                      updatedAt,
                      startDate: date,
                      endDate: date,
                      totals: usageTotals,
                      sessions: [
                        makeSession("agent:main:historical-hour", "Historical hour", updatedAt, {
                          ...usageTotals,
                          activityDates: [date],
                          messageCounts: messages,
                          utcQuarterHourMessageCounts: [{ date, quarterIndex, ...messages }],
                          utcQuarterHourTokenUsage: [{ date, quarterIndex, ...usageTotals }],
                        }),
                      ],
                      aggregates: {
                        ...empty["sessions.usage"].aggregates,
                        messages,
                        costDaily: [{ date, ...usageTotals }],
                      },
                    },
                  },
                  { match: {}, response: empty["sessions.usage"] },
                ],
              },
              "usage.status": { updatedAt, providers: [] },
            },
          });
          await page.goto(`${suite.server.baseUrl}usage`);
          await page
            .getByRole("combobox", { name: "Time zone", exact: true })
            .selectOption(timeZone);
          // The page title stays with its subtitle instead of moving into the toolbar row.
          await page.locator(".content-header--stacked .page-title").waitFor();
          const content = page.locator("main.content");
          await expect
            .poll(() =>
              content.evaluate((element) => element.classList.contains("content--hub-header")),
            )
            .toBe(true);
          expect(await content.evaluate((element) => getComputedStyle(element).paddingTop)).toBe(
            "16px",
          );
          const dateInputs = await page.locator(".usage-date-input").all();
          expect(dateInputs).toHaveLength(2);
          for (const input of dateInputs) {
            await input.fill(date);
            await input.press("Tab");
          }
          await expect
            .poll(async () => (await gateway.getRequests("sessions.usage")).at(-1)?.params)
            .toMatchObject(match);
          const hours = page.locator(".usage-error-list--hours");
          const cells = page.locator(".usage-hour-cell");
          const refresh = page
            .locator("openclaw-usage-page")
            .getByRole("button", { name: "Refresh", exact: true });
          for (const now of ["2026-03-07T17:00:00Z", "2026-03-08T16:00:00Z"]) {
            await page.clock.setFixedTime(new Date(now));
            const requests = (await gateway.getRequests("sessions.usage")).length;
            await refresh.click();
            await gateway.waitForRequest("sessions.usage", { after: requests });
            await expect.poll(() => refresh.isEnabled()).toBe(true);
            await expect.poll(() => cells.count()).toBe(24);
            await expect
              .poll(() => cells.nth(2).getAttribute("aria-label"))
              .toBe("2:00 · 100 tokens");
            await expectTexts(page.locator(".daily-bar-label"), ["Jan 15"]);
            await expect
              .poll(() => page.locator(".daily-bar-wrapper").getAttribute("aria-label"))
              .toBe("January 15, 2026: 100 tokens, $0.00");
            await hours.scrollIntoViewIfNeeded();
            await expect.poll(() => hours.isVisible()).toBe(true);
            await expect
              .poll(async () => ({
                labels: await trimmedTexts(hours.locator(".usage-list-label")),
                rates: await trimmedTexts(hours.locator(".usage-list-value")),
                details: await trimmedTexts(hours.locator(".usage-list-sub")),
              }))
              .toEqual({ labels: ["2 AM"], rates: ["50.00%"], details: ["5 errors · 10 msgs"] });
          }
          await cells.nth(2).click();
          await expect.poll(() => cells.nth(2).getAttribute("aria-pressed")).toBe("true");
          await expectTexts(page.locator(".session-bar-title"), ["Historical hour"]);
          await expectText(hours.locator(".usage-list-label")).toBe("2 AM");
          await cells.nth(2).click();
          await cells.nth(3).click();
          await expectTexts(page.locator(".session-bar-title"), []);
          await expect.poll(() => hours.count()).toBe(0);
          await page.getByRole("button", { name: "Remove hours filter", exact: true }).click();
          await expectTexts(page.locator(".session-bar-title"), ["Historical hour"]);
          await expectText(hours.locator(".usage-list-label")).toBe("2 AM");
        },
      );
    },
  );

  it.each(["recent-sort", "filtered", "recent-tab"])(
    "selects the visible session range with Shift-click (%s)",
    async (scenario) => {
      const updatedAt = Date.now();
      const sessions = [
        { label: "Visible A", tokens: 400 },
        { label: "Hidden", tokens: 300 },
        { label: "Visible B", tokens: 100 },
        { label: "Visible C", tokens: 200 },
      ].map(({ label, tokens }, index) =>
        makeSession(`agent:main:range-${index}`, label, updatedAt - index, {
          ...emptyTotals,
          input: tokens,
          totalTokens: tokens,
        }),
      );
      const empty = emptyUsageResponses();
      await suite.withPage(pageOptions, async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            ...empty,
            "sessions.usage": { ...empty["sessions.usage"], sessions },
            "sessions.usage.timeseries": { points: [] },
            "sessions.usage.logs": { logs: [] },
            "usage.status": { updatedAt, providers: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        const card = page.locator(".sessions-card");
        let list = card.locator(".session-bars").first();
        await expectTexts(
          list.locator(".session-bar-title"),
          sessions.map((session) => session.label),
        );
        if (scenario === "filtered") {
          await page.locator(".usage-query-input").fill("label:Visible");
          await page.locator(".usage-query-input").press("Enter");
          await expect.poll(() => list.locator(".session-bar-row").count()).toBe(3);
        }
        if (scenario === "recent-tab") {
          for (const name of ["Visible C", "Visible A", "Visible B"]) {
            await list.getByRole("button", { name, exact: true }).click();
          }
          await card.getByRole("button", { name: "Recently viewed", exact: true }).click();
          list = card.locator(".session-bars--recent");
          await expectTexts(list.locator(".session-bar-title"), [
            "Visible B",
            "Visible A",
            "Visible C",
          ]);
          await card.getByRole("button", { name: "Clear Selection", exact: true }).click();
        }
        const names = await list.locator(".session-bar-title").allTextContents();
        await list.getByRole("button", { name: names[0], exact: true }).click();
        await list
          .getByRole("button", { name: "Visible C", exact: true })
          .click({ modifiers: ["Shift"] });
        await expect
          .poll(async () =>
            (
              await list.locator('[aria-pressed="true"] .session-bar-title').allTextContents()
            ).toSorted(),
          )
          .toEqual(names.toSorted());
        if (scenario === "filtered") {
          await page.locator(".usage-query-input").fill("");
          await page.locator(".usage-query-input").press("Enter");
          await expect.poll(() => list.locator(".session-bar-row").count()).toBe(4);
          await expect
            .poll(() =>
              list
                .getByRole("button", { name: "Hidden", exact: true })
                .getAttribute("aria-pressed"),
            )
            .toBe("false");
        }
      });
    },
  );

  it.each([
    { outcome: "request-failed", failed: true },
    { outcome: "empty", failed: false },
  ])("handles provider usage status $outcome", async ({ failed }) => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          ...emptyUsageResponses(),
          "usage.status": failed
            ? { __mockError: { code: "INTERNAL_ERROR", message: "gateway transport unavailable" } }
            : { updatedAt: Date.now(), providers: [] },
        },
      });

      await page.goto(`${suite.server.baseUrl}usage`);
      await expect
        .poll(async () => (await gateway.getRequests("usage.status")).length)
        .toBeGreaterThan(0);
      await page.locator(".usage-empty-state").waitFor();
      const warning = "Provider usage is unavailable; the last request failed. Refresh to retry.";
      const content = expectText(page.locator(".usage-page"));
      if (failed) {
        await content.toContain(warning);
      } else {
        await content.not.toContain(warning);
      }
    });
  });

  it("keeps pending sessions visible when their UTC activity day is selected", async () => {
    const selectedDay = "2026-05-14";
    const updatedAt = Date.parse("2026-05-14T00:30:00.000Z");
    const pendingSessionKey = "agent:main:pending-cache";
    const cachedSessionKey = "agent:main:cached-usage";
    await suite.withPage(
      { ...pageOptions, timezoneId: "America/Los_Angeles" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt,
              startDate: selectedDay,
              endDate: selectedDay,
              sessions: [
                makeSession(cachedSessionKey, "Cached session", updatedAt, usageOnDay(selectedDay)),
                makeSession(pendingSessionKey, "Pending session", updatedAt, null),
              ],
              totals,
              aggregates: {
                ...emptyUsageResponses()["sessions.usage"].aggregates,
                byAgent: [{ agentId: "main", totals }],
                costDaily: [{ ...totals, date: selectedDay }],
                daily: [
                  {
                    date: selectedDay,
                    tokens: totals.totalTokens,
                    cost: totals.totalCost,
                    messages: 0,
                    toolCalls: 0,
                    errors: 0,
                  },
                ],
              },
              cacheStatus: { status: "refreshing", cachedFiles: 1, pendingFiles: 1, staleFiles: 0 },
            },
            "usage.status": { updatedAt, providers: [] },
          },
        });

        // The chart draws the selected calendar range, so "today" must contain the mocked day.
        await page.clock.setFixedTime(new Date("2026-05-14T12:00:00.000Z"));
        await page.goto(`${suite.server.baseUrl}usage`);
        const pendingRow = page.locator(".session-bar-row").filter({ hasText: "Pending session" });
        const cachedRow = page.locator(".session-bar-row").filter({ hasText: "Cached session" });
        await expect.poll(() => pendingRow.count(), { timeout: 10_000 }).toBe(1);

        await page.getByRole("combobox", { name: "Time zone", exact: true }).selectOption("utc");
        await expect
          .poll(async () => (await gateway.getRequests("sessions.usage")).at(-1)?.params)
          .toMatchObject({ mode: "utc" });
        await expect.poll(() => cachedRow.count(), { timeout: 10_000 }).toBe(1);
        // A refreshing report still draws the whole range; pick the recorded day.
        await page.locator(".daily-bar-wrapper:not(.daily-bar-wrapper--pending)").last().click();

        await expect.poll(() => cachedRow.count()).toBe(1);
        await expect.poll(() => pendingRow.count()).toBe(1);
      },
    );
  });

  it("edits equivalent provider filters and finds quoted session labels", async () => {
    const date = dayOffset(0);
    const updatedAt = Date.now();
    const sessions = [
      { provider: "openai", label: "Team Planning" },
      { provider: "anthropic", label: "Research Review" },
    ].map(({ provider, label }) =>
      makeSession(`agent:main:${provider}`, label, updatedAt, usageOnDay(date), {
        modelProvider: provider,
        model: `${provider}-model`,
      }),
    );
    const empty = emptyUsageResponses();
    await suite.withPage(pageOptions, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "sessions.usage": {
            ...empty["sessions.usage"],
            sessions,
            totals,
            aggregates: {
              ...empty["sessions.usage"].aggregates,
              costDaily: [dailyEntry(0, totals.totalCost, totals.totalTokens)],
            },
          },
          "usage.status": { updatedAt, providers: [] },
        },
      });

      await page.goto(`${suite.server.baseUrl}usage`);
      const sessionLabels = page.locator(".session-bar-title");
      await expect
        .poll(async () => (await sessionLabels.allTextContents()).toSorted())
        .toEqual(["Research Review", "Team Planning"]);

      const providerFilter = page.locator(".usage-filter-select").filter({
        has: page.locator(".usage-filter-trigger", { hasText: "Provider" }),
      });
      await providerFilter.locator(".usage-filter-trigger").click();
      await providerFilter.locator('[data-value="command:select-all"]').click();
      await expectText(providerFilter.locator(".settings-count")).toBe("2");
      await expect
        .poll(async () => (await sessionLabels.allTextContents()).toSorted())
        .toEqual(["Research Review", "Team Planning"]);

      const query = page.locator(".usage-query-input");
      await page.keyboard.press("Escape");
      for (const token of ["PROVIDER:OpenAI", 'provider:"openai"']) {
        await query.fill(`${token} provider:anthropic`);
        await query.press("Enter");
        await expect
          .poll(async () => (await sessionLabels.allTextContents()).toSorted())
          .toEqual(["Research Review", "Team Planning"]);
        await providerFilter.locator(".usage-filter-trigger").click();
        const openai = providerFilter.locator('[data-value="option:openai"]');
        await expect.poll(() => openai.getAttribute("aria-checked")).toBe("true");
        await openai.click();
        await expectTexts(sessionLabels, ["Research Review"]);
        await expect.poll(() => query.inputValue()).toBe("provider:anthropic ");
        await page.keyboard.press("Escape");
      }
      await query.fill('label:"Team Planning"');
      await query.press("Enter");
      await expectTexts(sessionLabels, ["Team Planning"]);
    });
  });

  it("renders cost analysis from Gateway usage data", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const daily = [
        dailyEntry(-89, 5, 500_000),
        dailyEntry(-29, 7, 700_000),
        dailyEntry(-6, 9, 900_000),
        dailyEntry(0, 11, 1_100_000),
      ];
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.usage.timeseries": { points: [] },
          "sessions.usage.logs": { logs: [] },
          "agents.list": {
            agents: [
              { id: "main", name: "Main" },
              { id: "writer", name: "Writer" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "sessions.usage": {
            updatedAt: Date.now(),
            startDate: dayOffset(-89),
            endDate: dayOffset(0),
            sessions: [
              {
                ...makeSession("agent:main:cost-analysis", "Cost analysis", Date.now(), {
                  ...totals,
                  activityDates: daily.map((entry) => entry.date),
                  dailyBreakdown: daily.map((entry) => ({
                    ...entry,
                    cost: entry.totalCost,
                    tokens: entry.totalTokens,
                  })),
                  messageCounts: costMessages,
                  modelUsage,
                }),
                modelProvider: "openai",
                model: "gpt-5.5",
              },
            ],
            totals,
            aggregates: {
              messages: costMessages,
              tools: { totalCalls: 12, uniqueTools: 2, tools: [{ name: "exec", count: 8 }] },
              byModel: modelUsage,
              byProvider: modelUsage.map(({ provider, count, totals: modelTotals }) => ({
                provider,
                count,
                totals: modelTotals,
              })),
              byAgent: [{ agentId: "main", totals }],
              byChannel: [],
              costDaily: daily,
              daily: daily.map((entry) => ({
                date: entry.date,
                tokens: entry.totalTokens,
                cost: entry.totalCost,
                messages: 10,
                toolCalls: 3,
                errors: 0,
              })),
            },
          },
          "usage.status": {
            updatedAt: Date.now(),
            providers: [
              providerHistory(
                "openai",
                "OpenAI",
                98.75,
                "Responses",
                [
                  [-6, 38.5, 12_300],
                  [0, 60.25, 18_450],
                ],
                "gpt-5.5",
              ),
              providerHistory(
                "anthropic",
                "Anthropic",
                42.4,
                "Claude API",
                [
                  [-6, 17.15],
                  [0, 25.25],
                ],
                "claude-opus-4-8",
              ),
              {
                provider: "openrouter",
                displayName: "OpenRouter",
                plan: "Production",
                windows: [{ label: "API key budget", usedPercent: 25 }],
                billing: [
                  {
                    type: "balance",
                    label: "Account balance",
                    amount: 64.5,
                    unit: "USD",
                  },
                  {
                    type: "budget",
                    label: "API key budget",
                    used: 5,
                    limit: 20,
                    unit: "USD",
                  },
                ],
                summary: "$1.25 today · $5.00 this month",
              },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}usage`);
      await page.locator(".daily-chart-compact").waitFor({ state: "visible", timeout: 10_000 });
      const agentScope = page.locator(".agent-scope-control openclaw-agent-select");
      await agentScope.locator(".agent-select__trigger").click();
      await agentScope
        .locator(".agent-select__option[data-agent-option]")
        .filter({ hasText: "All agents" })
        .click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.usage")).at(-1)?.params)
        .toMatchObject({ agentScope: "all" });
      const requestsBeforeRangeChange = (await gateway.getRequests("sessions.usage")).length;
      await page.getByRole("button", { name: "90d", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.usage")).length)
        .toBeGreaterThan(requestsBeforeRangeChange);
      await page.getByRole("button", { name: "Cost", exact: true }).click();

      const windowCards = page.locator(".cost-window");
      await expect.poll(() => windowCards.count()).toBe(4);
      await expect
        .poll(async () => ({
          labels: await windowCards.locator(".cost-window__label").allTextContents(),
          values: await trimmedTexts(windowCards.locator(".cost-window__value")),
        }))
        .toEqual({
          labels: ["Selected Range", "Today", "Last 7 days", "Last 30 days"],
          values: ["$32.00", "$11.00", "$20.00", "$27.00"],
        });
      await expectTexts(page.locator(".daily-chart-scale span"), ["$20", "$10", "$0"]);
      await expectText(page.locator(".usage-insight-card", { hasText: "Top Providers" })).toContain(
        "OpenAI",
      );
      const messagesHint = page.locator("#usage-summary-hint-messages");
      const messagesTooltipHost = messagesHint.locator("xpath=..");
      const messagesTooltip = messagesTooltipHost.locator(".tooltip-surface[popover]");
      await messagesHint.hover();
      await expectPopover(messagesTooltip, true);
      await page.mouse.move(1, 1);
      await expectPopover(messagesTooltip, false);

      await page.keyboard.press("Tab");
      await messagesHint.focus();
      await expectPopover(messagesTooltip, true);
      await page.getByRole("button", { name: "Cost", exact: true }).focus();
      await expectPopover(messagesTooltip, false);

      await messagesHint.click();
      await expectPopover(messagesTooltip, true);
      await expectText(messagesTooltipHost.locator('[slot="content"]')).toContain(
        "Total user and assistant messages in range.",
      );
      await page.getByRole("button", { name: "Cost", exact: true }).click();
      await expectPopover(messagesTooltip, false);
      await page.keyboard.press("Tab");
      await messagesHint.focus();
      await expectPopover(messagesTooltip, true);
      await messagesHint.press("Escape");
      await expectPopover(messagesTooltip, false);
      const providerCards = page.locator(".provider-usage-card");
      await expect.poll(() => providerCards.count()).toBe(3);
      await expect
        .poll(async () => (await gateway.getRequests("usage.status")).length)
        .toBeGreaterThan(0);
      await expectText(providerCards.filter({ hasText: "OpenRouter" })).toContain("$64.50");
      await expectText(providerCards.filter({ hasText: "OpenAI" })).toContain("$98.75");
      await expectText(providerCards.filter({ hasText: "Anthropic" })).toContain("claude-opus-4-8");

      await page.locator(".usage-query-input").fill("missing-session");
      await page.locator(".usage-query-input").press("Enter");
      const topProviders = page.locator(".usage-insight-card", { hasText: "Top Providers" });
      await expectText(topProviders).toContain("No provider data");
      await expectText(topProviders).not.toContain("OpenAI");
    });
  });
});
