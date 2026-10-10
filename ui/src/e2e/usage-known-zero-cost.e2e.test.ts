import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createRecordedCostUsage } from "../pages/usage/test-helpers/recorded-cost.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI known-zero usage cost mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

suite.define(() => {
  it("shows the recorded cost hint through ordinary Usage filters", async () => {
    const normalHint = "Average cost per message when providers report costs.";
    const missingHint = `${normalHint} Cost data is missing for some or all sessions in this range.`;
    const updatedAt = Date.now();
    const fixture = createRecordedCostUsage(updatedAt);
    const responses = {
      "sessions.usage": {
        updatedAt,
        startDate: fixture.costDaily[0]!.date,
        endDate: fixture.costDaily.at(-1)!.date,
        sessions: fixture.sessions,
        totals: fixture.totals,
        aggregates: {
          messages: { total: 6, user: 3, assistant: 3, toolCalls: 0, toolResults: 0, errors: 0 },
          tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
          byModel: [],
          byProvider: [],
          byAgent: [],
          byChannel: [],
          daily: [],
          costDaily: fixture.costDaily,
        },
      },
      "usage.status": { updatedAt, providers: [] },
    };
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
          if (step.stage === "cleared") {
            await page
              .locator(".usage-query-actions")
              .getByRole("button", { name: "Clear", exact: true })
              .click();
          } else if (step.stage !== "mixed") {
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
          if (artifactDir && ["mixed", "known-zero"].includes(step.stage)) {
            const screenshot = path.join(artifactDir, `${step.stage}.png`);
            await writeFile(
              screenshot,
              await takeControlUiViewportScreenshot(page, popup, [hintButton, hintContent, value]),
            );
            screenshots.push(screenshot);
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
        const requests = await gateway.getRequests();
        expect(requests.some(({ method }) => method === "sessions.usage")).toBe(true);
        expect(requests.some(({ method }) => method === "usage.status")).toBe(true);
        const record = {
          observations,
          screenshots,
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
});
