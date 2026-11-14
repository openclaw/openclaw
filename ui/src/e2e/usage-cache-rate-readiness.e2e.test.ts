import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { usageTotals, buildAggregatesFromSessions } from "../pages/usage/view.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway } from "./usage-overview-fixture.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Usage cache rate readiness mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const options = {
  colorScheme: "light",
  locale: "en-US",
  timezoneId: "UTC",
  viewport: { width: 1440, height: 1100 },
  serviceWorkers: "block",
} as const;
function response(input: number) {
  const now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  const totals = usageTotals(input, 0);
  const sessions = [
    {
      key: "agent:main:awaiting-answer",
      label: "New conversation",
      agentId: "main",
      modelProvider: "openai",
      updatedAt: now,
      usage: {
        ...totals,
        computedAt: now,
        messageCounts: {
          total: input > 0 ? 2 : 1,
          user: 1,
          assistant: input > 0 ? 1 : 0,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        },
        firstActivity: now,
        lastActivity: now,
      },
    },
  ];
  return {
    updatedAt: now,
    startDate: date,
    endDate: date,
    sessions,
    totals,
    aggregates: buildAggregatesFromSessions(sessions),
  };
}
suite.define(() => {
  it("does not warn about a cache rate with no input tokens", async () => {
    await suite.withPage(options, async ({ page }) => {
      const gateway = await installUsageOverviewGateway(page, {
        methodResponses: {
          "sessions.usage": response(0),
          "usage.status": { updatedAt: 1, providers: [] },
        },
      });
      await page.goto(suite.server.baseUrl + "usage");
      const card = page
        .locator(".usage-summary-card")
        .filter({ has: page.locator("#usage-summary-hint-cache-hit-rate") });
      await card.waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const artifacts = createControlUiE2eArtifactDir("usage-empty-cache-rate-review");
        const frame = await takeControlUiScreenshotFrame(page, card, [card], {
          elements: [card],
          animations: "disabled",
          scrollTo: card,
        });
        await writeFile(path.join(artifacts, "empty-cache-rate.png"), frame.png);
      }
      expect(await card.getAttribute("class")).not.toContain("usage-summary-card--bad");
      await gateway.setMethodResponse("sessions.usage", response(100));
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(() => card.textContent()).toContain("0.0%");
      expect(await card.getAttribute("class")).toContain("usage-summary-card--bad");
    });
  });
});
