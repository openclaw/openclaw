import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createCronJob,
  createCronRunsResult,
  cronJobsListResponse,
} from "../lib/cron/cron.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron history recovery diagnostics",
  startServerBeforeBrowser: true,
});

const alpha = createCronJob("alpha-history", "Alpha synthetic automation");
const beta = createCronJob("beta-history", "Beta synthetic automation");
const alphaSummary = "Alpha-only completed run";
const recoveredSummary = "Recovered current run";
const historyError = "Synthetic run history temporarily unavailable";
function runsResponse(summary: string) {
  return createCronRunsResult([
    {
      ts: Date.parse("2026-09-16T12:00:00.000Z"),
      jobId: alpha.id,
      jobName: alpha.name,
      action: "finished",
      status: "ok",
      summary,
    },
  ]);
}

async function installScenario(page: Page, failInitially = false) {
  const gateway = await installMockGateway(page, {
    methodResponses: {
      "cron.list": cronListResponseFixture(cronJobsListResponse([alpha, beta])),
      "cron.runs": failInitially
        ? { __mockError: { code: "UNAVAILABLE", message: historyError } }
        : runsResponse(alphaSummary),
      "cron.status": { enabled: true, jobs: 2, triggersEnabled: true },
    },
  });
  await page.goto(`${suite.server.baseUrl}cron`);
  await page.locator('[data-test-id="cron-list-tab-activity"]').click();
  return gateway;
}

async function capture(page: Page, stage: string) {
  const snapshot = {
    rows: await page.locator(".cron-run-entry").allTextContents(),
    errors: await page.locator(".cron-error-banner").allTextContents(),
    empty: await page.locator(".cron-empty-state").allTextContents(),
    loading: await page.locator('[data-test-id="cron-runs-loading"]').count(),
  };
  await page.locator("openclaw-cron-page").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(suite.artifactDir, `${stage}.png`) });
  await writeFile(path.join(suite.artifactDir, `${stage}.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

suite.define(() => {
  it("distinguishes pending, failed, and confirmed empty history after selecting another automation", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installScenario(page);
      await page.locator(".cron-run-entry", { hasText: alphaSummary }).waitFor();
      await capture(page, "overview-loaded");

      await page.locator('[data-test-id="cron-tab-all"]').click();
      await gateway.deferNext("cron.runs", { id: beta.id });
      await page.locator(`[data-test-id="cron-row-${beta.id}"] .cron-table__name`).click();
      await gateway.waitForRequest("cron.runs", { match: { id: beta.id } });
      await page.locator('[data-test-id="cron-detail-tab-history"]').click();
      await page.locator(".cron-detail-title", { hasText: beta.name }).waitFor();
      const pending = await capture(page, "beta-history-pending");

      await gateway.rejectDeferred("cron.runs", { code: "UNAVAILABLE", message: historyError });
      await page.locator(".cron-error-banner", { hasText: historyError }).waitFor();
      const failed = await capture(page, "beta-history-failed");

      for (const snapshot of [pending, failed]) {
        expect(snapshot.rows.join(" ")).not.toContain(alphaSummary);
        expect(snapshot.empty.join(" ")).not.toContain("No runs yet");
      }
      expect([pending, failed]).toMatchObject([{ loading: 1 }, { loading: 0 }]);

      await gateway.setMethodResponse("cron.runs", createCronRunsResult([]));
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.getByText("No runs yet", { exact: true }).waitFor();
      const empty = await capture(page, "beta-history-confirmed-empty");
      expect(empty).toMatchObject({ errors: [], loading: 0 });
    });
  });

  it("clears the history failure after a successful explicit Refresh", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installScenario(page, true);
      await page.locator(".cron-error-banner", { hasText: historyError }).waitFor();
      await capture(page, "history-failed");

      await gateway.setMethodResponse("cron.runs", runsResponse(recoveredSummary));
      await page.locator(".cron-refresh").click();
      await page.locator(".cron-run-entry", { hasText: recoveredSummary }).waitFor();
      const recovered = await capture(page, "history-refreshed");

      expect(recovered.rows.join(" ")).toContain(recoveredSummary);
      expect(recovered.errors.join(" ")).not.toContain(historyError);
    });
  });
});
