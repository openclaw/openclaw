import { expect, it } from "vitest";
import type { CronRunLogEntry } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList, cronRuns } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI automation job links" });

suite.define(() => {
  it("opens a linked automation and run outside their first inventory pages", async () => {
    const job = cronJob("linked-automation", "Linked automation", {
      agentId: "writer",
      configRevision: "linked-definition",
      createdAtMs: 1,
      updatedAtMs: 1,
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Produce the scheduled report." },
    });
    const jobs = Array.from({ length: 50 }, (_, index) => ({
      ...job,
      id: `other-${index}`,
      agentId: "main",
      name: `Other automation ${index}`,
    }));
    const run = {
      ts: 2,
      jobId: job.id,
      action: "finished",
      runId: "linked-run",
      sessionId: "linked-session",
      runAtMs: 1,
      status: "ok",
      summary: "Linked report completed.",
    } satisfies CronRunLogEntry;
    const recentRuns = Array.from({ length: 50 }, (_, index) => ({
      ...run,
      ts: 100 + index,
      runId: `recent-run-${index}`,
      sessionId: `recent-session-${index}`,
      runAtMs: 99 + index,
      summary: `Recent report ${index}`,
    }));
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "cron.status": { enabled: true, jobs: 51, nextWakeAtMs: null },
          "cron.list": cronListResponseFixture(
            cronList(jobs, "linked-inventory", {
              total: 51,
              offset: 0,
              hasMore: true,
              nextOffset: 50,
            }),
          ),
          "cron.get": job,
          "cron.runs": {
            cases: [
              {
                match: { id: job.id, runId: run.runId },
                response: cronRuns([run]),
              },
              {
                match: { id: job.id, offset: 50 },
                response: cronRuns([run], { total: 51, offset: 50 }),
              },
              {
                match: { id: job.id },
                response: cronRuns(recentRuns, { total: 51, hasMore: true, nextOffset: 50 }),
              },
              {
                response: cronRuns([]),
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}cron?job=${job.id}&run=${run.runId}`);
      await gateway.waitForRequest("cron.list");
      await page.locator(".cron-detail-title").waitFor();
      expect(await page.locator(".cron-detail-title").textContent()).toContain(job.name);
      expect((await gateway.getRequests("cron.get")).map(({ params }) => params)).toEqual([
        { id: job.id },
      ]);
      await page.locator('.cron-runs[aria-busy="false"] .cron-run-entry').first().waitFor();
      await takeControlUiScreenshotFrame(
        page,
        page.locator(".cron-page"),
        [page.locator(".cron-detail-title"), page.locator(".cron-run-entry").first()],
        { animations: "disabled" },
      );
      expect(await page.locator(".cron-run-entry--highlighted").count()).toBe(1);
      expect(await page.locator(".cron-run-entry--highlighted").textContent()).toContain(
        run.summary,
      );
      const history = await gateway.getRequests("cron.runs");
      expect(history).toContainEqual(
        expect.objectContaining({
          params: expect.objectContaining({ id: job.id, scope: "job", runId: run.runId }),
        }),
      );
      expect(history).not.toContainEqual(
        expect.objectContaining({
          params: expect.objectContaining({ id: job.id, agentId: expect.anything() }),
        }),
      );
      await page.getByRole("button", { name: "Show all runs", exact: true }).click();
      await page.getByText("Recent report 49", { exact: true }).waitFor();
      expect(await page.locator(".cron-run-entry--highlighted").count()).toBe(0);
      expect(await page.locator(".cron-run-entry").count()).toBe(50);
      await page.getByRole("button", { name: "Load more runs", exact: true }).click();
      await page.getByText(run.summary, { exact: true }).waitFor();
      expect(await page.locator(".cron-run-entry").count()).toBe(51);
    });
  });
});
