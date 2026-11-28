import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { expectCount, expectText } from "./activity-assertions.test-support.ts";
import {
  activityPolishFixture,
  activityPolishKeys as keys,
  activityPolishPullRequest,
} from "./activity-polish.test-support.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Activity recap and preview states" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const screenshot = async (page: Page, name: string) => {
  if (captureUiProof) {
    await page.screenshot({ path: path.join(suite.artifactDir, `${name}.png`) });
  }
};

suite.define(() => {
  it.each([
    ["Australia/Lord_Howe", "2026-10-04T01:30:00+10:30", "3 AM"],
    ["Australia/Lord_Howe", "2026-04-05T01:30:00+11:00", "2 AM"],
    ["America/New_York", "2026-03-08T01:00:00-05:00", "3 AM"],
    ["America/New_York", "2026-11-01T01:00:00-04:00", "1 AM"],
    ["Asia/Kathmandu", "2026-10-04T00:00:00+05:45", "1 AM"],
    ["UTC", "2026-04-05T00:00:00Z", "1 AM"],
  ])(
    "labels the hourly Activity peak from its boundary in %s at %s",
    async (timezoneId, start, label) => {
      await suite.withPage({ timezoneId, locale: "en-US" }, async ({ page }) => {
        const since = Date.parse(start);
        const hour = 3_600_000;
        // On Lord Howe the cutoff falls just after the offset change, but the first bin starts before it.
        await page.clock.setFixedTime(new Date(since + 24 * hour + 45 * 60_000));
        const list = chatSessionListResponse([
          {
            key: "agent:main:peak",
            kind: "direct",
            label: "Peak session",
            updatedAt: since + hour,
          },
        ]);
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.list": {
              ...list,
              activityPulse: {
                since,
                until: since + 25 * hour,
                buckets: Array.from({ length: 25 }, (_, index) => Number(index === 1)),
                sessions: 1,
                running: 0,
              },
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}activity?time=24h`);
        const request = await gateway.waitForRequest("sessions.list", {
          match: { activeMinutes: 1440 },
        });
        expect(request.params).toHaveProperty(
          "activityPulseBoundaries",
          Array.from({ length: 26 }, (_, index) => since + index * hour),
        );
        const chart = page.getByRole("img", { name: /Last 24 hours/ });
        await chart.locator(".activity-pulse__bar").nth(1).hover();
        const tooltip = page.locator("openclaw-tooltip .tooltip-content").filter({ visible: true });
        await tooltip.waitFor();
        expect({
          tooltip: (await tooltip.textContent())?.trim(),
          summary: await chart.getAttribute("aria-label"),
        }).toEqual({
          tooltip: `${label} · 1 session`,
          summary: `Last 24 hours: 1 session by last activity; most sessions at ${label}`,
        });
      });
    },
  );

  it.each([
    { width: 1440, height: 1100, colorScheme: "light" as const },
    { width: 390, height: 844, colorScheme: "dark" as const },
  ])(
    "keeps Activity understandable during loading and refresh failure at $width px",
    async ({ width, height, colorScheme }) => {
      await suite.withPage(
        { viewport: { width, height }, colorScheme, locale: "en-US" },
        async ({ page }) => {
          const fixture = activityPolishFixture();
          const gateway = await installMockGateway(page, fixture.scenario);
          await page.goto(`${suite.server.baseUrl}activity`);
          await gateway.waitForRequest("sessions.list", {
            match: { includeActivitySummary: true },
          });
          const loading = page.locator(".activity-feed__loading");
          await loading.waitFor();
          expect(await loading.getAttribute("aria-busy")).toBe("true");
          expect(await loading.locator(".skeleton").count()).toBeGreaterThan(0);
          await screenshot(page, `01-loading-${width}`);

          await gateway.resolveDeferred("sessions.list", fixture.list);
          const activity = page.locator("openclaw-activity-page");
          const recap = (key: string) => activity.locator(`[data-activity-recap="${key}"]`);
          const row = (key: string) =>
            activity
              .locator(".activity-feed__session-row")
              .filter({ has: page.locator(`[data-activity-session="${key}"]`) });
          const sessions = activity.locator("[data-activity-session]");
          await expectCount(sessions).toBe(4);
          expect(
            await sessions.evaluateAll((links) =>
              links.map((link) => link.getAttribute("data-activity-session")),
            ),
          ).toEqual(Object.values(keys));
          const listRequest = await gateway.waitForRequest("sessions.list", {
            match: { includeActivitySummary: true },
          });
          expect(listRequest.params).toMatchObject({ sortBy: "activity" });
          const currentRow = row(keys.current);
          expect(await currentRow.locator(".activity-feed__session-time").textContent()).toContain(
            "1m",
          );
          await expectText(currentRow.locator(".agent-row-chip")).toContain("Roboclaw");
          expect(await currentRow.locator(".activity-feed__session-meta").textContent()).toContain(
            "Alex Morgan",
          );
          const updating = recap(keys.updating);
          expect(await updating.getAttribute("aria-busy")).toBe("true");
          expect(await updating.locator("p").textContent()).toContain("Testing focus behavior");
          expect(await updating.locator(".activity-feed__note").count()).toBe(0);
          const unavailable = await recap(keys.unavailable).textContent();
          expect(unavailable).toContain("Couldn’t refresh the recap. Try again.");
          expect(unavailable).not.toContain("Recap unavailable");
          expect(await recap(keys.initial).locator(".skeleton").count()).toBe(2);
          expect(await gateway.getRequests("chat.history")).toEqual([]);
          await gateway.emitGatewayEvent(
            CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
            fixture.pullRequests,
          );
          const pr = currentRow.locator(".activity-feed__pr");
          await pr.waitFor();
          await screenshot(page, `02-recaps-${width}`);
          await pr.focus();
          const card = page.locator(".link-reader-hovercard");
          await expectText(card).toContain(activityPolishPullRequest.title);
          await gateway.waitForRequest(TEST_LINK_READER.linkReader.previewMethod!);
          await gateway.rejectDeferred(TEST_LINK_READER.linkReader.previewMethod!, {
            code: "UNAVAILABLE",
            message: "Preview enrichment unavailable",
          });
          await expectText(card).toContain(activityPolishPullRequest.title);
          await screenshot(page, `03-hover-${width}`);
          await page.keyboard.press("Escape");
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        },
      );
    },
  );
});
