import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob, CronJobsListResult } from "../api/types.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const key = "agent:main:automation-preview";
const NOW = Date.parse("2026-10-14T06:00:00Z");
const prompt =
  "Check the linked PR for failed checks and unresolved review comments. Fix actionable issues and verify the changes.\nFollow the repository’s review and test workflow. Recheck current state before making changes. Report blockers in the originating session; do not bypass required checks or reviews.";
const withPage = (run: Parameters<typeof suite.withPage>[1], width = 1440) =>
  suite.withPage(
    { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 900 } },
    run,
  );
function job(id = "ci", overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: "Check CI and comments",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 300_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: prompt },
    state: {
      nextRunAtMs: NOW + 120_000,
      lastRunAtMs: NOW - 180_000,
      lastRunStatus: "ok",
    },
    ...overrides,
  };
}
function inventory(jobs: CronJob[], overrides: Partial<CronJobsListResult> = {}) {
  return cronListResponseFixture({
    jobs,
    snapshotRevision: "inspection-1",
    total: jobs.length,
    limit: 20,
    offset: 0,
    nextOffset: null,
    hasMore: false,
    ...overrides,
  });
}
async function installSessionFixture(page: Page, jobs: CronJob[]) {
  await page.clock.setFixedTime(NOW);
  const gateway = await installMockGateway(page, {
    sessionKey: key,
    featureMethods: ["progressCard.get", "cron.list"],
    methodResponses: {
      "progressCard.get": { card: null },
      "cron.list": inventory(jobs),
      "cron.get": { cases: jobs.map((value) => ({ match: { id: value.id }, response: value })) },
      "sessions.list": chatSessionListResponse([
        {
          key,
          kind: "direct",
          label: "Refresh versus retry distinction",
          hasAutomation: true,
          updatedAt: 1,
        },
      ]),
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
  return gateway;
}
suite.define(() => {
  it.each([
    { width: 1440, entry: "desktop" },
    { width: 390, entry: "single" },
    { width: 390, entry: "list" },
  ])("opens the selected automation page from $entry Details", async ({ width, entry }) => {
    await withPage(async ({ page }) => {
      const selected = job("release + review", { name: "Release review" });
      const jobs = entry === "single" ? [selected] : [job(), selected];
      const gateway = await installSessionFixture(page, jobs);
      const details = await openChatDetails(page);
      const automations = details.locator('[data-details-group="automations"]');
      if (entry === "desktop") {
        await automations.getByRole("link", { name: /Release review/ }).click();
      } else if (entry === "single") {
        await automations.getByRole("button", { name: /Release review/ }).click();
      } else {
        await automations.locator('[data-details-destination="automations"]').click();
        await details.getByRole("link", { name: /Release review/ }).click();
      }
      await page.waitForURL((url) => url.pathname === "/automations");
      expect(new URL(page.url()).searchParams.get("job")).toBe(selected.id);
      await page.locator(".cron-detail-title").getByText(selected.name, { exact: true }).waitFor();
      expect((await gateway.getRequests("cron.get")).map(({ params }) => params)).toContainEqual({
        id: selected.id,
      });
      expect(await page.locator(".chat-mobile-host").filter({ visible: true }).count()).toBe(0);
    }, width);
  });
});
