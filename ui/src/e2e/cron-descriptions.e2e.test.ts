import fs from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { CronJob } from "../api/types.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob as makeCronJob, cronList } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron saved descriptions E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

function cronJob(id: string, name: string): CronJob {
  return makeCronJob(id, name, {
    createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
    updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
    payload: { kind: "systemEvent", text: `${name} fired` },
  });
}

const captureDurationProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const requireDurationRecord = createRequireRecord("record", "expected-object-value");
const pageOptions = createControlUiE2eContextOptions();
const durationPageOptions = () => ({
  ...pageOptions,
  ...(captureDurationProofEnabled
    ? { recordVideo: { dir: suite.artifactDir, size: { width: 1_280, height: 900 } } }
    : {}),
});

function durationResponses(jobs: CronJob[]) {
  const list = (entries: CronJob[]) => cronList(entries, "exact-duration-fixture");
  return {
    "cron.list": cronListResponseFixture([
      { match: { lastRunStatus: "error" }, response: list([]) },
      { response: list(jobs) },
    ]),
    "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
    "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  };
}

async function captureDurationProof(page: Page, name: string, content: Locator) {
  if (!captureDurationProofEnabled) {
    return;
  }
  await content.scrollIntoViewIfNeeded();
  await fs.writeFile(
    path.join(suite.artifactDir, `${name}.png`),
    await takeControlUiViewportScreenshot(page, page.locator(".cron-page"), [content]),
  );
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
          methodResponses: durationResponses([job]),
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator(`[data-test-id="cron-row-${job.id}"] .cron-table__name-text`).click();
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
          await page.locator('[data-test-id="cron-submit"]:not(:disabled)').waitFor();
        }
        const previous = (await gateway.getRequests("cron.update")).length;
        await at.fill("2027-03-14T02:30");
        await captureDurationProof(page, "dst-gap", at);
        expect(await at.getAttribute("aria-invalid")).toBe("true");
        expect(await submit.isDisabled()).toBe(true);
        expect(await page.locator(".cron-schedule-summary").count()).toBe(0);
        expect(await gateway.getRequests("cron.update")).toHaveLength(previous);
      },
    );
  });

  it("configured duration precision: shows exact saved intervals in rows and details", async () => {
    const cases = [
      { id: "minute-control", everyMs: 60_000, text: "Every 1m" },
      { id: "mixed-interval", everyMs: 90_000, text: "Every 1m 30s" },
      { id: "precise-interval", everyMs: 3_661_001, text: "Every 1h 1m 1s 1ms" },
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
    await suite.withPage(durationPageOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: durationResponses(jobs),
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      await page.locator(`[data-test-id="cron-row-${cases[0].id}"]`).waitFor();
      await captureDurationProof(
        page,
        "interval-list",
        page.locator(`[data-test-id="cron-row-${cases[0].id}"]`),
      );
      for (const [index, job] of jobs.entries()) {
        const row = page.locator(`[data-test-id="cron-row-${job.id}"]`);
        expect(await row.locator(".cron-table__description").count()).toBe(0);
        expect(await row.getAttribute("class")).toContain("cron-table__row--paused");
        const rowText = (
          await row.locator(".cron-table__schedule .cron-table__cell-value").textContent()
        )?.trim();
        await row.locator(".cron-table__name-text").click();
        const subtitle = page.locator(".cron-detail-meta > .cron-detail-sub");
        await subtitle.waitFor();
        const detail = (await subtitle.textContent())?.trim();
        const text = cases[index]?.text;
        expect({ row: rowText, detail }).toEqual({ row: text, detail: text });
        await captureDurationProof(page, job.id, subtitle);
        await page.locator('[data-test-id="cron-back"]').click();
        await row.waitFor();
      }
      expect(await gateway.getRequests("cron.run")).toHaveLength(0);
    });
  });
});
