import { expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { CronJob } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  cronJob,
  cronList,
  cronSidebarFeatureMethods,
  editAutomation,
  openAutomation,
} from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron saved descriptions E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const requireDurationRecord = createRequireRecord("record", "expected-object-value");
const pageOptions = createControlUiE2eContextOptions();

function durationResponses(jobs: CronJob[]) {
  const list = (entries: CronJob[]) => cronList(entries, "exact-duration-fixture");
  return {
    "cron.list": cronListResponseFixture([
      { match: { lastRunStatus: "error" }, response: list([]) },
      { response: list(jobs) },
    ]),
    "cron.get": { cases: jobs.map((job) => ({ match: { id: job.id }, response: job })) },
    "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
    "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  };
}

suite.define(() => {
  it("one-shot local time: rejects DST gaps and preserves real instants", async () => {
    const job = {
      ...cronJob("dst-one-shot", "Synthetic DST reminder"),
      enabled: false,
      configRevision: "dst-definition",
      schedule: { kind: "at", at: "2027-11-07T06:30:56.789Z" },
    } satisfies CronJob;
    await suite.withPage(
      { locale: "en-US", timezoneId: "America/New_York", viewport: { width: 1280, height: 1100 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: cronSidebarFeatureMethods,
          methodResponses: durationResponses([job]),
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await editAutomation(page, job.id);
        const at = page.locator("#cron-schedule-at");
        const submit = page.locator('[data-test-id="cron-submit"]');
        expect(await at.inputValue()).toBe("2027-11-07T01:30");
        for (const [local, expected] of [
          ["2027-11-07T01:30", undefined],
          ["2027-03-14T01:30", "2027-03-14T06:30:00.000Z"],
          ["2027-03-14T03:30", "2027-03-14T07:30:00.000Z"],
          ["2027-11-07T01:31", "2027-11-07T05:31:00.000Z"],
        ] as const) {
          await at.fill(local);
          await page.locator("#cron-name").fill(`Synthetic DST reminder ${local}`);
          const previous = (await gateway.getRequests("cron.update")).length;
          await gateway.deferNext("cron.update");
          await submit.click();
          const request = await gateway.waitForRequest("cron.update", { after: previous });
          const patch = requireDurationRecord(requireDurationRecord(request.params).patch);
          expect(patch.schedule).toEqual(expected ? { kind: "at", at: expected } : undefined);
          const saved = { ...job, ...patch, configRevision: `dst-${previous}` };
          await gateway.setMethodResponse("cron.list", durationResponses([saved])["cron.list"]);
          await gateway.resolveDeferred("cron.update", saved);
          // A saved edit returns to the prompt; Edit reopens the form for the next instant.
          await page.locator('[data-test-id="cron-edit"]').click();
          await page.locator('[data-test-id="cron-submit"]:not(:disabled)').waitFor();
        }
        const previous = (await gateway.getRequests("cron.update")).length;
        await at.fill("2027-03-14T02:30");
        expect(await at.getAttribute("aria-invalid")).toBe("true");
        expect(await submit.isDisabled()).toBe(true);
        expect(await page.locator('[data-test-id="cron-schedule-note"]').count()).toBe(0);
        expect(await gateway.getRequests("cron.update")).toHaveLength(previous);
      },
    );
  });

  it("configured duration precision: shows exact saved intervals in the list and details", async () => {
    const cases = [
      { id: "minute-control", everyMs: 60_000, cadence: "Every 1 minute" },
      { id: "mixed-interval", everyMs: 90_000, cadence: "Every 1 minute 30 seconds" },
      {
        id: "precise-interval",
        everyMs: 3_661_001,
        cadence: "Every 1 hour 1 minute 1 second 1 millisecond",
      },
    ] as const;
    const jobs = cases.map(
      ({ id, everyMs }) =>
        ({
          ...cronJob(id, id),
          enabled: false,
          configRevision: `${id}-definition`,
          schedule: { kind: "every", everyMs },
        }) satisfies CronJob,
    );
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: cronSidebarFeatureMethods,
        methodResponses: durationResponses(jobs),
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      for (const [index, job] of jobs.entries()) {
        const row = await openAutomation(page, job.id);
        const rowText = (await row.locator(".sidebar-automations__byline").textContent())?.trim();
        const subtitle = page.locator(".cron-detail-meta > .cron-detail-sub");
        await subtitle.waitFor();
        const detail = (await subtitle.textContent())?.trim();
        const cadence = cases[index]?.cadence;
        expect({ row: rowText, detail }).toEqual({
          row: `Paused · ${cadence}`,
          detail: `${cadence} · Paused`,
        });
      }
      expect(await gateway.getRequests("cron.run")).toHaveLength(0);
    });
  });
});
