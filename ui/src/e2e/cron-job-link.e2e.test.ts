import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI automation job links" });

suite.define(() => {
  it("opens a linked automation and run outside their first inventory pages", async () => {
    const job: CronJob = {
      id: "linked-automation",
      agentId: "writer",
      configRevision: "linked-definition",
      name: "Linked automation",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Produce the scheduled report." },
      state: {},
    };
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
    };
    const recentRuns = Array.from({ length: 50 }, (_, index) => ({
      ...run,
      ts: 100 + index,
      runId: `recent-run-${index}`,
      sessionId: `recent-session-${index}`,
      runAtMs: 99 + index,
      summary: `Recent report ${index}`,
    }));
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.status": { enabled: true, jobs: 51, nextWakeAtMs: null },
            "cron.list": cronListResponseFixture({
              jobs,
              total: 51,
              offset: 0,
              limit: 50,
              hasMore: true,
              nextOffset: 50,
              snapshotRevision: "linked-inventory",
            }),
            "cron.get": job,
            "cron.runs": {
              cases: [
                {
                  match: { id: job.id, runId: run.runId },
                  response: {
                    entries: [run],
                    total: 1,
                    offset: 0,
                    limit: 50,
                    hasMore: false,
                    nextOffset: null,
                  },
                },
                {
                  match: { id: job.id, offset: 50 },
                  response: {
                    entries: [run],
                    total: 51,
                    offset: 50,
                    limit: 50,
                    hasMore: false,
                    nextOffset: null,
                  },
                },
                {
                  match: { id: job.id },
                  response: {
                    entries: recentRuns,
                    total: 51,
                    offset: 0,
                    limit: 50,
                    hasMore: true,
                    nextOffset: 50,
                  },
                },
                {
                  response: {
                    entries: [],
                    total: 0,
                    offset: 0,
                    limit: 50,
                    hasMore: false,
                    nextOffset: null,
                  },
                },
              ],
            },
          },
        });
        try {
          await page.goto(`${suite.server.baseUrl}cron?job=${job.id}&run=${run.runId}`);
          await gateway.waitForRequest("cron.list");
          await page.locator(".cron-detail-title").waitFor();
          expect(await page.locator(".cron-detail-title").textContent()).toContain(job.name);
          expect((await gateway.getRequests("cron.get")).map(({ params }) => params)).toEqual([
            { id: job.id },
          ]);
          await page.locator('.cron-runs[aria-busy="false"] .cron-run-entry').first().waitFor();
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".cron-page"),
            [page.locator(".cron-detail-title"), page.locator(".cron-run-entry").first()],
            { animations: "disabled" },
          );
          await fs.writeFile(path.join(suite.artifactDir, "linked-run.png"), frame.png);
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
        } finally {
          await fs.writeFile(
            path.join(suite.artifactDir, "gateway-requests.json"),
            JSON.stringify(await gateway.getRequests(), null, 2),
          );
        }
      },
    );
  });
});
