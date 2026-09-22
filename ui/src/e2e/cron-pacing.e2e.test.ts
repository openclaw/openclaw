import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { applyJobPatch } from "../../../src/cron/service/jobs.js";
import type { CronStoredJob } from "../../../src/cron/types.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Automation pacing browser proof",
  startServerBeforeBrowser: true,
});
const record = createRequireRecord("record", "expected-object-value");
const source: CronStoredJob = {
  id: "paced-watch",
  name: "Synthetic paced watcher",
  enabled: true,
  createdAtMs: 0,
  updatedAtMs: 0,
  schedule: { kind: "every", everyMs: 60_000 },
  pacing: { min: "5m", max: "1h" },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Check synthetic status and choose the next check." },
  delivery: { mode: "none" },
  state: {},
};
const list = {
  jobs: [{ ...source, configRevision: "source-revision" }],
  snapshotRevision: "pacing-proof",
  total: 1,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
};

suite.define(() => {
  it.each(["duplicate", "once"])("preserves valid pacing through %s", async (action) => {
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": list,
            "cron.status": { enabled: true, jobs: 1, triggersEnabled: true },
            "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator(".cron-table__row").waitFor();
        if (action === "duplicate") {
          await page.locator(".cron-job-menu__trigger").click();
          await page.locator('wa-dropdown-item[value="clone"]').click();
        } else {
          await page.locator(".cron-table__row").click();
          await page.locator('[data-test-id="cron-schedule-kind-at"]').click();
          await page.locator("#cron-schedule-at").fill("2099-01-01T12:00");
        }
        const method = action === "duplicate" ? "cron.add" : "cron.update";
        await gateway.deferNext(method);
        await page.locator('[data-test-id="cron-submit"]').click();
        const request = await gateway.waitForRequest(method);
        const params = record(request.params);
        let error: string | undefined;
        if (action === "once") {
          const patch = record(params.patch);
          const schedule = record(patch.schedule);
          try {
            applyJobPatch(structuredClone(source), {
              schedule: { kind: "at", at: String(schedule.at) },
              ...(patch.pacing === null ? { pacing: null } : {}),
            });
          } catch (failure) {
            error = String(failure);
          }
          if (error) {
            await gateway.rejectDeferred(method, { code: "INVALID_REQUEST", message: error });
            await page.locator(".cron-error-banner").waitFor();
          } else {
            await gateway.resolveDeferred(method, {
              ...source,
              schedule: patch.schedule,
              pacing: undefined,
              configRevision: "saved-revision",
            });
            await expect
              .poll(() => page.locator('[data-test-id="cron-submit"]').isEnabled())
              .toBe(true);
          }
        } else {
          await gateway.resolveDeferred(method, { id: "paced-copy" });
          await page.locator('[data-test-id="cron-new-task"]').waitFor();
        }
        if (action === "once") {
          await page.locator(".cron-detail-title").scrollIntoViewIfNeeded();
        }
        await page.screenshot({ path: path.join(suite.artifactDir, `${action}.png`) });
        await writeFile(
          path.join(suite.artifactDir, `${action}.json`),
          JSON.stringify({ request, error }, null, 2),
        );
        if (action === "duplicate") {
          expect(params.pacing).toEqual(source.pacing);
        } else {
          expect(error).toBeUndefined();
          expect(record(params.patch).pacing).toBeNull();
        }
      },
    );
  });
});
