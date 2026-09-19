import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob, CronRunLogEntry } from "../api/types.ts";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron history recovery diagnostics",
  startServerBeforeBrowser: true,
});

function job(id: string, name: string): CronJob {
  return {
    id,
    name,
    configRevision: `synthetic-${id}`,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Synthetic history diagnostic" },
    state: {},
  };
}

const alpha = job("alpha-history", "Alpha synthetic automation");
const beta = job("beta-history", "Beta synthetic automation");
const alphaSummary = "Alpha-only completed run";
const recoveredSummary = "Recovered current run";
const historyError = "Synthetic run history temporarily unavailable";
const listResponse = {
  jobs: [alpha, beta],
  snapshotRevision: "history-recovery-fixture",
  total: 2,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
};

function runsResponse(summary: string) {
  const entries: CronRunLogEntry[] = [
    {
      ts: Date.parse("2026-09-16T12:00:00.000Z"),
      jobId: alpha.id,
      jobName: alpha.name,
      action: "finished",
      status: "ok",
      summary,
    },
  ];
  return { entries, total: entries.length, offset: 0, limit: 50, hasMore: false, nextOffset: null };
}

async function installScenario(page: Page, failInitially = false) {
  return installMockGateway(page, {
    methodResponses: {
      "cron.list": cronListResponseFixture(listResponse),
      "cron.runs": failInitially
        ? { __mockError: { code: "UNAVAILABLE", message: historyError } }
        : runsResponse(alphaSummary),
      "cron.status": { enabled: true, jobs: 2, triggersEnabled: true },
    },
  });
}

async function capture(page: Page, gateway: MockGatewayControls, stage: string) {
  const snapshot = {
    title: await page.locator(".cron-detail-title").allTextContents(),
    rows: await page.locator(".cron-run-entry").allTextContents(),
    errors: await page.locator(".cron-error-banner").allTextContents(),
    requests: await gateway.getRequests("cron.runs"),
  };
  await page.locator("openclaw-cron-page").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(suite.artifactDir, `${stage}.png`) });
  await writeFile(path.join(suite.artifactDir, `${stage}.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

suite.define(() => {
  it("does not present previous automation runs while the selected history is pending or failed", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installScenario(page);
      await page.goto(`${suite.server.baseUrl}cron`);
      await page.locator('[data-test-id="cron-list-tab-activity"]').click();
      await page.locator(".cron-run-entry", { hasText: alphaSummary }).waitFor();
      await capture(page, gateway, "overview-loaded");

      await page.locator('[data-test-id="cron-tab-all"]').click();
      await gateway.deferNext("cron.runs", { id: beta.id });
      await page.locator(`[data-test-id="cron-row-${beta.id}"] .cron-table__name`).click();
      await gateway.waitForRequest("cron.runs", { match: { id: beta.id } });
      await page.locator('[data-test-id="cron-detail-tab-history"]').click();
      await page.locator(".cron-detail-title", { hasText: beta.name }).waitFor();
      const pending = await capture(page, gateway, "beta-history-pending");

      await gateway.rejectDeferred("cron.runs", { code: "UNAVAILABLE", message: historyError });
      await page.locator(".cron-error-banner", { hasText: historyError }).waitFor();
      const failed = await capture(page, gateway, "beta-history-failed");

      // Preserve both diagnostic states before evaluating either outcome.
      expect(pending.rows.join(" ")).not.toContain(alphaSummary);
      expect(failed.rows.join(" ")).not.toContain(alphaSummary);
    });
  });

  it("clears the history failure after a successful explicit Refresh", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installScenario(page, true);
      await page.goto(`${suite.server.baseUrl}cron`);
      await page.locator('[data-test-id="cron-list-tab-activity"]').click();
      await page.locator(".cron-error-banner", { hasText: historyError }).waitFor();
      await capture(page, gateway, "history-failed");

      await gateway.setMethodResponse("cron.runs", runsResponse(recoveredSummary));
      await page.locator(".cron-refresh").click();
      await page.locator(".cron-run-entry", { hasText: recoveredSummary }).waitFor();
      const recovered = await capture(page, gateway, "history-refreshed");

      expect(recovered.rows.join(" ")).toContain(recoveredSummary);
      expect(recovered.errors.join(" ")).not.toContain(historyError);
    });
  });
});
