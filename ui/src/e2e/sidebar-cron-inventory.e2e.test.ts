import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createCronJob,
  cronJobsListResponse,
  createCronRunsResult,
  cronListResponseFixture,
} from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { automationRow, cronSidebarFeatureMethods } from "./cron-fixtures.test-support.ts";
import { sidebarCronJob, captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar automation inventory" });
const pageResponse = (offset: number) => ({
  jobs: [
    sidebarCronJob({
      id: `job-${offset}`,
      name: `Report ${offset}`,
      state: { lastRunStatus: offset === 0 ? "ok" : "error", nextRunAtMs: 1 },
    }),
  ],
  snapshotRevision: "inventory",
  total: 2,
  limit: 1,
  offset,
  hasMore: offset === 0,
  nextOffset: offset === 0 ? 1 : null,
});

suite.define(() => {
  it.each([true, false])(
    "keeps the focused automation when its inventory refreshes (enabled=%s)",
    async (enabled) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 800 }, locale: "en-US" },
        async ({ page }) => {
          const job = createCronJob("notes", "Review release notes", { enabled });
          const other = createCronJob("digest", "Weekly digest");
          const response = (changed: boolean) =>
            cronListResponseFixture(
              cronJobsListResponse(
                [
                  other,
                  changed
                    ? { ...job, name: "Review release notes and examples", updatedAtMs: 2 }
                    : job,
                ],
                { snapshotRevision: changed ? "second" : "first" },
              ),
            );
          const gateway = await installMockGateway(page, {
            featureMethods: [...cronSidebarFeatureMethods, "cron.runs", "cron.status"],
            methodResponses: {
              "cron.list": response(false),
              "cron.runs": createCronRunsResult([]),
              "cron.status": { enabled: true, jobs: 2, nextWakeAtMs: null },
            },
          });
          await page.goto(suite.server.baseUrl + "automations?activity");
          const row = await automationRow(page, job.id);
          await row.focus();
          await page.keyboard.press("Shift+Tab");
          await page.keyboard.press("Tab");
          expect(await row.evaluate((el) => el === document.activeElement)).toBe(true);
          const original = await row.evaluateHandle((el) => el);
          await gateway.setMethodResponse("cron.list", response(true));
          await gateway.emitGatewayEvent("cron.inventory.changed", {});
          await expect.poll(() => row.textContent()).toContain("Review release notes and examples");
          await captureSidebarUiProof(suite, page, "refreshed-" + String(enabled) + ".png");
          expect(await original.evaluate((el) => el === document.activeElement)).toBe(true);
          await page.keyboard.press("Enter");
          await expect.poll(() => new URL(page.url()).searchParams.get("job")).toBe(job.id);
        },
      );
    },
  );
  it("requests compact automation data on every inventory page", () =>
    suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "cron.list": cronListResponseFixture([
            { match: { offset: 1 }, response: pageResponse(1) },
            { response: pageResponse(0) },
          ]),
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const clock = page.locator('.sidebar-rail [data-sidebar-entry="route:cron"] a');
      await expect
        .poll(() => clock.getAttribute("aria-description"))
        .toBe("An automation has failed");
      const finish = async (offset: number, lastRunStatus: "ok" | "error") => {
        const job = pageResponse(offset).jobs[0]!;
        await gateway.emitGatewayEvent("cron", {
          action: "finished",
          jobId: job.id,
          job: { ...job, state: { ...job.state, lastRunStatus } },
        });
      };
      await finish(0, "error");
      await finish(1, "ok");
      await expect
        .poll(() => clock.getAttribute("aria-description"))
        .toBe("An automation has failed");
      await page.locator(".sidebar-issues-button").click();
      const inbox = page.locator("#sidebar-issues-panel");
      await inbox.locator(".sidebar-issues-panel__empty").waitFor();
      expect(await inbox.getByText(/Report [01]/).count()).toBe(0);
      await finish(0, "ok");
      await expect.poll(() => clock.getAttribute("aria-description")).toBeNull();
      expect((await gateway.getRequests("cron.list")).map(({ params }) => params)).toEqual([
        expect.objectContaining({ compact: true }),
        expect.objectContaining({ compact: true, offset: 1 }),
      ]);
    }));
});
