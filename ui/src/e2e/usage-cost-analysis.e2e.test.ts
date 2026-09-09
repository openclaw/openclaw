import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createCostAnalysisResponses,
  createRecordedCostResponses,
  createUsageDailyEntries,
  dailyEntry,
  dayOffset,
  emptyTotals,
  emptyUsageResponses,
  chartTotals as totals,
} from "../pages/usage/usage-fixtures.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI usage cost analysis mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

const daily = createUsageDailyEntries();

suite.define(() => {
  it("shows the recorded cost hint through ordinary Usage filters", async () => {
    const normalHint = "Average cost per message when providers report costs.";
    const missingHint = `${normalHint} Cost data is missing for some or all sessions in this range.`;
    const updatedAt = Date.now();
    const date = dayOffset(0);
    const empty = emptyUsageResponses();
    const responses = createRecordedCostResponses(updatedAt, date, empty);
    const initialResponses = structuredClone(responses);
    const artifactDir = recordVisuals
      ? createControlUiE2eArtifactDir("usage-known-zero-cost", suite.artifactDir)
      : null;
    const observations: Array<{
      stage: string;
      query: string;
      hint: string;
      value: string;
      labels: string[];
      visible: boolean;
    }> = [];
    const screenshots: string[] = [];
    const diagnostics: Array<{ stage: string; geometryFile: string; screenshot: string }> = [];
    await suite.withPage(
      {
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date(updatedAt));
        const gateway = await installMockGateway(page, {
          communityInviteDismissed: true,
          methodResponses: responses,
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        const query = page.locator(".usage-query-input");
        const hintButton = page.locator("#usage-summary-hint-average-cost");
        const card = page.locator(".usage-summary-card").filter({ has: hintButton });
        const tooltipHost = hintButton.locator("xpath=..");
        const tooltip = tooltipHost.locator("wa-tooltip");
        const tooltipBody = tooltip.locator('[part="body"]');
        const popup = tooltip.locator('wa-popup [part="popup"]');
        const hintContent = tooltipHost.locator('[slot="content"]');
        const value = card.locator(".usage-summary-value");
        const steps = [
          { stage: "mixed", query: "", count: 3, value: "$0.03" },
          { stage: "known-zero", query: 'label:"Known zero"', count: 1, value: "$0.00" },
          { stage: "cleared", query: "", count: 3, value: "$0.03" },
          { stage: "positive", query: 'label:"Known positive"', count: 1, value: "$0.10" },
          { stage: "unknown", query: 'label:"Unpriced usage"', count: 1, value: "$0.00" },
        ];
        for (const step of steps) {
          if (step.stage !== "mixed") {
            await query.fill(step.query);
            await query.press("Enter");
          }
          await expect.poll(() => page.locator(".session-bar-title").count()).toBe(step.count);
          await expect.poll(async () => (await value.textContent())?.trim()).toBe(step.value);
          await card.evaluate((element) =>
            element.scrollIntoView({ block: "center", behavior: "instant" }),
          );
          await hintButton.click();
          await expect.poll(() => tooltip.getAttribute("open")).toBe("");
          await expect.poll(() => tooltipBody.isVisible()).toBe(true);
          await expect.poll(() => hintContent.isVisible()).toBe(true);
          await waitForControlUiProofSurface(popup, [hintContent, value]);
          const geometry: Array<{
            name: string;
            bounds: Awaited<ReturnType<typeof card.boundingBox>>;
          }> = [];
          for (const [name, surface] of [
            ["card", card],
            ["tooltip-body", tooltipBody],
            ["hint-content", hintContent],
          ] as const) {
            geometry.push({ name, bounds: await surface.boundingBox() });
          }
          if (artifactDir) {
            const geometryFile = path.join(artifactDir, `${step.stage}-geometry.json`);
            const screenshot = path.join(artifactDir, `${step.stage}.png`);
            await writeFile(geometryFile, JSON.stringify({ stage: step.stage, geometry }, null, 2));
            await writeFile(
              screenshot,
              await takeControlUiViewportScreenshot(page, popup, [hintButton, hintContent, value]),
            );
            diagnostics.push({ stage: step.stage, geometryFile, screenshot });
            if (["mixed", "known-zero"].includes(step.stage)) {
              screenshots.push(screenshot);
            }
          }
          for (const { name, bounds } of geometry) {
            if (!bounds) {
              throw new Error(`Expected visible cost hint bounds: ${step.stage}/${name}`);
            }
            const label = `${step.stage}/${name}`;
            expect(bounds.width, `${label} width`).toBeGreaterThan(0);
            expect(bounds.height, `${label} height`).toBeGreaterThan(0);
            expect(bounds.x, `${label} left`).toBeGreaterThanOrEqual(0);
            expect(bounds.y, `${label} top`).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width, `${label} right`).toBeLessThanOrEqual(1440);
            expect(bounds.y + bounds.height, `${label} bottom`).toBeLessThanOrEqual(900);
          }
          const observed = {
            stage: step.stage,
            query: await query.inputValue(),
            hint: (await hintContent.textContent())?.trim() ?? "",
            value: (await value.textContent())?.trim() ?? "",
            labels: (await page.locator(".session-bar-title").allTextContents()).toSorted(),
            visible: await tooltipBody.isVisible(),
          };
          observations.push(observed);
          if (step.stage !== "known-zero") {
            expect(observed.hint).toBe(step.stage === "positive" ? normalHint : missingHint);
          }
          await hintButton.press("Escape");
          await expect.poll(() => tooltip.getAttribute("open")).toBeNull();
          await expect.poll(() => tooltipBody.isVisible()).toBe(false);
        }
        expect(responses).toEqual(initialResponses);
        const requests = await gateway.getRequests();
        const forbidden = requests.filter(({ method }) =>
          ["chat.send", "config.set", "config.patch", "sessions.patch"].includes(method),
        );
        expect(forbidden).toEqual([]);
        expect(requests.some(({ method }) => method === "sessions.usage")).toBe(true);
        expect(requests.some(({ method }) => method === "usage.status")).toBe(true);
        const record = {
          observations,
          screenshots,
          diagnostics,
          responses,
          responsesUnchanged: true,
          forbiddenRequests: forbidden,
          requests: requests.map(({ method }) => method),
        };
        if (artifactDir) {
          await writeFile(path.join(artifactDir, "receipts.json"), JSON.stringify(record, null, 2));
        }
        expect(
          observations.find(({ stage }) => stage === "known-zero")?.hint,
          "USAGE_KNOWN_ZERO_BROWSER",
        ).toBe(normalHint);
      },
    );
  });

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
      const artifactDir = recordVisuals ? path.join(suite.artifactDir, "usage-hour-labels") : null;
      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
      }
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          timezoneId: "America/New_York",
          viewport: { height: 1_000, width: 1_440 },
          ...(artifactDir
            ? { recordVideo: { dir: artifactDir, size: { height: 1_000, width: 1_440 } } }
            : {}),
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
                        {
                          key: "agent:main:historical-hour",
                          label: "Historical hour",
                          agentId: "main",
                          updatedAt,
                          usage: {
                            ...usageTotals,
                            activityDates: [date],
                            messageCounts: messages,
                            utcQuarterHourMessageCounts: [{ date, quarterIndex, ...messages }],
                            utcQuarterHourTokenUsage: [{ date, quarterIndex, ...usageTotals }],
                          },
                        },
                      ],
                      aggregates: { ...empty["sessions.usage"].aggregates, messages },
                    },
                  },
                  { match: {}, response: empty["sessions.usage"] },
                ],
              },
              "usage.cost": {
                cases: [
                  {
                    match,
                    response: {
                      updatedAt,
                      days: 1,
                      daily: [{ date, ...usageTotals }],
                      totals: usageTotals,
                    },
                  },
                  { match: {}, response: empty["usage.cost"] },
                ],
              },
              "usage.status": { updatedAt, providers: [] },
            },
          });
          await page.goto(`${suite.server.baseUrl}usage`);
          await page.locator(".usage-select").selectOption(timeZone);
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
            .locator(".usage-controls")
            .getByRole("button", { name: "Refresh", exact: true });
          for (const [stage, now] of [
            ["control", "2026-03-07T17:00:00Z"],
            ["dst-gap", "2026-03-08T16:00:00Z"],
          ] as const) {
            await page.clock.setFixedTime(new Date(now));
            const requests = (await gateway.getRequests("sessions.usage")).length;
            await refresh.click();
            await gateway.waitForRequest("sessions.usage", { after: requests });
            await expect.poll(() => refresh.isEnabled()).toBe(true);
            await expect.poll(() => cells.count()).toBe(24);
            await expect
              .poll(() => cells.nth(2).getAttribute("aria-label"))
              .toBe("2:00 · 100 tokens");
            await expect
              .poll(() => page.locator(".daily-bar-label").allTextContents())
              .toEqual(["Jan 15"]);
            await expect
              .poll(() => page.locator(".daily-bar-wrapper").getAttribute("aria-label"))
              .toBe("January 15, 2026: 100 tokens, $0.00");
            await hours.scrollIntoViewIfNeeded();
            await expect.poll(() => hours.isVisible()).toBe(true);
            if (artifactDir) {
              await page.screenshot({
                animations: "disabled",
                path: path.join(artifactDir, `${timeZone}-${stage}.png`),
              });
            }
            await expect
              .poll(async () => ({
                labels: (await hours.locator(".usage-error-date").allTextContents()).map((text) =>
                  text.trim(),
                ),
                rates: (await hours.locator(".usage-error-rate").allTextContents()).map((text) =>
                  text.trim(),
                ),
                details: (await hours.locator(".usage-error-sub").allTextContents()).map((text) =>
                  text.trim(),
                ),
              }))
              .toEqual({ labels: ["2 AM"], rates: ["50.00%"], details: ["5 errors · 10 msgs"] });
          }
          await cells.nth(2).click();
          await expect.poll(() => cells.nth(2).getAttribute("aria-pressed")).toBe("true");
          await expect
            .poll(() => page.locator(".session-bar-title").allTextContents())
            .toEqual(["Historical hour"]);
          await expect.poll(() => hours.locator(".usage-error-date").textContent()).toBe("2 AM");
          await cells.nth(2).click();
          await cells.nth(3).click();
          await expect.poll(() => page.locator(".session-bar-title").allTextContents()).toEqual([]);
          await expect.poll(() => hours.count()).toBe(0);
          await page.getByRole("button", { name: "Remove hours filter", exact: true }).click();
          await expect
            .poll(() => page.locator(".session-bar-title").allTextContents())
            .toEqual(["Historical hour"]);
          await expect.poll(() => hours.locator(".usage-error-date").textContent()).toBe("2 AM");
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
      ].map(({ label, tokens }, index) => ({
        key: `agent:main:range-${index}`,
        label,
        agentId: "main",
        updatedAt: updatedAt - index,
        usage: { ...emptyTotals, input: tokens, totalTokens: tokens },
      }));
      const empty = emptyUsageResponses();
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 1_000, width: 1_440 } },
        async ({ page }) => {
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
          await expect
            .poll(() => list.locator(".session-bar-title").allTextContents())
            .toEqual(sessions.map((session) => session.label));
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
            await expect
              .poll(() => list.locator(".session-bar-title").allTextContents())
              .toEqual(["Visible B", "Visible A", "Visible C"]);
            await card.getByRole("button", { name: "Clear Selection", exact: true }).click();
          }
          const names = await list.locator(".session-bar-title").allTextContents();
          await list.getByRole("button", { name: names[0], exact: true }).click();
          await list
            .getByRole("button", { name: "Visible C", exact: true })
            .click({ modifiers: ["Shift"] });
          if (recordVisuals) {
            const artifactDir = path.join(suite.artifactDir, "usage-range-selection");
            await card.screenshot({ path: path.join(artifactDir, `${scenario}.png`) });
          }
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
        },
      );
    },
  );

  it("shows a visible provider usage warning when the usage status request fails", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...emptyUsageResponses(),
            "usage.status": {
              __mockError: { code: "INTERNAL_ERROR", message: "gateway transport unavailable" },
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}usage`);
        await expect
          .poll(async () => (await gateway.getRequests("usage.status")).length)
          .toBeGreaterThan(0);
        await page.locator(".usage-empty-state").waitFor();
        await expect
          .poll(() => page.locator(".usage-page").textContent())
          .toContain("Provider usage is unavailable; the last request failed. Refresh to retry.");
        if (recordVisuals) {
          await mkdir(path.join(suite.artifactDir, "provider-usage-outcomes"), { recursive: true });
          await page.locator(".usage-page").screenshot({
            animations: "disabled",
            path: path.join(
              path.join(suite.artifactDir, "provider-usage-outcomes"),
              "usage-status-request-failed.png",
            ),
          });
        }
      },
    );
  });

  it("does not show the provider usage warning for a valid empty response", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...emptyUsageResponses(),
            "usage.status": { updatedAt: Date.now(), providers: [] },
          },
        });

        await page.goto(`${suite.server.baseUrl}usage`);
        await expect
          .poll(async () => (await gateway.getRequests("usage.status")).length)
          .toBeGreaterThan(0);
        await page.locator(".usage-empty-state").waitFor();
        await expect
          .poll(() => page.locator(".usage-page").textContent())
          .not.toContain(
            "Provider usage is unavailable; the last request failed. Refresh to retry.",
          );
        if (recordVisuals) {
          await mkdir(path.join(suite.artifactDir, "provider-usage-outcomes"), { recursive: true });
          await page.locator(".usage-page").screenshot({
            animations: "disabled",
            path: path.join(
              path.join(suite.artifactDir, "provider-usage-outcomes"),
              "usage-status-empty.png",
            ),
          });
        }
      },
    );
  });

  it("keeps pending sessions visible when their UTC activity day is selected", async () => {
    const selectedDay = "2026-05-14";
    const updatedAt = Date.parse("2026-05-14T00:30:00.000Z");
    const pendingSessionKey = "agent:main:pending-cache";
    const cachedSessionKey = "agent:main:cached-usage";
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        timezoneId: "America/Los_Angeles",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt,
              startDate: selectedDay,
              endDate: selectedDay,
              sessions: [
                {
                  key: cachedSessionKey,
                  label: "Cached session",
                  agentId: "main",
                  updatedAt,
                  usage: {
                    ...totals,
                    activityDates: [selectedDay],
                    dailyBreakdown: [
                      {
                        ...totals,
                        date: selectedDay,
                        cost: totals.totalCost,
                        tokens: totals.totalTokens,
                      },
                    ],
                  },
                },
                {
                  key: pendingSessionKey,
                  label: "Pending session",
                  agentId: "main",
                  updatedAt,
                  usage: null,
                },
              ],
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
                byAgent: [{ agentId: "main", totals }],
                byChannel: [],
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
            "usage.cost": {
              updatedAt,
              days: 1,
              daily: [{ ...totals, date: selectedDay }],
              totals,
            },
            "usage.status": { updatedAt, providers: [] },
          },
        });

        await page.goto(`${suite.server.baseUrl}usage`);
        const pendingRow = page.locator(".session-bar-row").filter({ hasText: "Pending session" });
        const cachedRow = page.locator(".session-bar-row").filter({ hasText: "Cached session" });
        await expect.poll(() => pendingRow.count(), { timeout: 10_000 }).toBe(1);

        await page.locator(".usage-select").selectOption("utc");
        await expect
          .poll(async () => (await gateway.getRequests("sessions.usage")).at(-1)?.params)
          .toMatchObject({ mode: "utc" });
        await expect.poll(() => cachedRow.count(), { timeout: 10_000 }).toBe(1);
        await page.locator(".daily-bar-wrapper").click();

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
    ].map(({ provider, label }) => ({
      key: `agent:main:${provider}`,
      label,
      agentId: "main",
      modelProvider: provider,
      model: `${provider}-model`,
      updatedAt,
      usage: {
        ...totals,
        activityDates: [date],
        dailyBreakdown: [{ ...totals, date, cost: totals.totalCost, tokens: totals.totalTokens }],
      },
    }));
    const empty = emptyUsageResponses();
    if (recordVisuals) {
      await mkdir(path.join(suite.artifactDir, "usage-filter-repair"), { recursive: true });
    }

    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
        ...(recordVisuals
          ? {
              recordVideo: {
                dir: path.join(suite.artifactDir, "usage-filter-repair"),
                size: { height: 1_000, width: 1_440 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": { ...empty["sessions.usage"], sessions, totals },
            "usage.cost": {
              ...empty["usage.cost"],
              daily: [dailyEntry(0, totals.totalCost, totals.totalTokens)],
              totals,
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
        await providerFilter.locator('wa-dropdown-item[value="command:select-all"]').click();
        await expect.poll(() => providerFilter.locator(".settings-count").textContent()).toBe("2");
        await expect
          .poll(async () => (await sessionLabels.allTextContents()).toSorted())
          .toEqual(["Research Review", "Team Planning"]);
        if (recordVisuals) {
          await writeFile(
            path.join(
              path.join(suite.artifactDir, "usage-filter-repair"),
              "01-provider-alternatives.png",
            ),
            await takeControlUiViewportScreenshot(page, providerFilter.locator('[part="menu"]'), [
              providerFilter.locator('wa-dropdown-item[value="option:openai"]'),
            ]),
          );
        }

        const query = page.locator(".usage-query-input");
        await page.keyboard.press("Escape");
        for (const token of ["PROVIDER:OpenAI", 'provider:"openai"']) {
          await query.fill(`${token} provider:anthropic`);
          await query.press("Enter");
          await expect
            .poll(async () => (await sessionLabels.allTextContents()).toSorted())
            .toEqual(["Research Review", "Team Planning"]);
          await providerFilter.locator(".usage-filter-trigger").click();
          const openai = providerFilter.locator('wa-dropdown-item[value="option:openai"]');
          await expect.poll(() => openai.getAttribute("aria-checked")).toBe("true");
          await openai.click();
          await expect.poll(() => sessionLabels.allTextContents()).toEqual(["Research Review"]);
          await expect.poll(() => query.inputValue()).toBe("provider:anthropic ");
          await page.keyboard.press("Escape");
        }
        await query.fill('label:"Team Planning"');
        await query.press("Enter");
        await expect.poll(() => sessionLabels.allTextContents()).toEqual(["Team Planning"]);
        if (recordVisuals) {
          await writeFile(
            path.join(
              path.join(suite.artifactDir, "usage-filter-repair"),
              "02-quoted-session-label.png",
            ),
            await takeControlUiViewportScreenshot(page, page.locator(".usage-page"), [query]),
          );
        }
      },
    );
  });

  it("renders cost analysis from Gateway usage data", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: createCostAnalysisResponses(daily),
        });

        await page.goto(`${suite.server.baseUrl}usage`);
        await page.locator(".daily-chart-compact").waitFor({ state: "visible", timeout: 10_000 });
        const agentScope = page.locator(".agent-scope-control openclaw-agent-select");
        await agentScope.locator(".agent-select__trigger").click();
        await agentScope
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: "All agents" })
          .click();
        await expect
          .poll(async () => (await gateway.getRequests("usage.cost")).at(-1)?.params)
          .toMatchObject({ agentScope: "all" });
        const costRequestsBeforeRangeChange = (await gateway.getRequests("usage.cost")).length;
        await page.getByRole("button", { name: "90d", exact: true }).click();
        await expect
          .poll(async () => (await gateway.getRequests("usage.cost")).length)
          .toBeGreaterThan(costRequestsBeforeRangeChange);
        await page.getByRole("button", { name: "Cost", exact: true }).click();

        const windowCards = page.locator(".cost-window-card");
        await expect.poll(() => windowCards.count()).toBe(4);
        await expect
          .poll(async () => ({
            labels: await windowCards.locator(".cost-window-card__label").allTextContents(),
            values: (await windowCards.locator(".cost-window-card__value").allTextContents()).map(
              (value) => value.trim(),
            ),
          }))
          .toEqual({
            labels: ["Selected Range", "Today", "Last 7 days", "Last 30 days"],
            values: ["$32.00", "$11.00", "$20.00", "$27.00"],
          });
        await expect
          .poll(() => page.locator(".daily-chart-scale span").allTextContents())
          .toEqual(["$11.00", "$5.50", "$0.00"]);
        await expect
          .poll(() =>
            page.locator(".usage-insight-card", { hasText: "Top Providers" }).textContent(),
          )
          .toContain("openai");
        const messagesHint = page.locator("#usage-summary-hint-messages");
        const messagesTooltipHost = messagesHint.locator("xpath=..");
        const messagesTooltip = messagesTooltipHost.locator("wa-tooltip");
        await messagesHint.hover();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
        await page.mouse.move(1, 1);
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();

        await page.keyboard.press("Tab");
        await messagesHint.focus();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
        await page.getByRole("button", { name: "Cost", exact: true }).focus();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();

        await messagesHint.click();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
        await expect
          .poll(() => messagesTooltipHost.locator('[slot="content"]').textContent())
          .toContain("Total user and assistant messages in range.");
        await page.getByRole("button", { name: "Cost", exact: true }).click();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();
        await page.keyboard.press("Tab");
        await messagesHint.focus();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
        await messagesHint.press("Escape");
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();
        const providerCards = page.locator(".provider-usage-card");
        await expect.poll(() => providerCards.count()).toBe(3);
        await expect
          .poll(async () => (await gateway.getRequests("usage.status")).length)
          .toBeGreaterThan(0);
        await expect
          .poll(() => providerCards.filter({ hasText: "OpenRouter" }).textContent())
          .toContain("$64.50");
        await expect
          .poll(() => providerCards.filter({ hasText: "OpenAI" }).textContent())
          .toContain("$98.75");
        await expect
          .poll(() => providerCards.filter({ hasText: "Anthropic" }).textContent())
          .toContain("claude-opus-4-8");

        await page.locator(".usage-query-input").fill("missing-session");
        await page.locator(".usage-query-input").press("Enter");
        const topProviders = page.locator(".usage-insight-card", { hasText: "Top Providers" });
        await expect.poll(() => topProviders.textContent()).toContain("No provider data");
        await expect.poll(() => topProviders.textContent()).not.toContain("openai");

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifactDir = path.join(suite.artifactDir, "provider-plans");
          await page.locator(".usage-page").screenshot({
            path: path.join(artifactDir, "after.png"),
          });
        }
      },
    );
  });
});
