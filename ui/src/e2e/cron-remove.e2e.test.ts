// Control UI tests own the destructive Automation removal flow through the rendered page.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron removal mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const job: CronJob = {
  id: "nightly-digest",
  name: "Nightly digest",
  enabled: true,
  createdAtMs: Date.parse("2026-08-11T08:00:00.000Z"),
  updatedAtMs: Date.parse("2026-08-11T08:05:00.000Z"),
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Summarize the overnight activity" },
  state: {},
};

function cronListResponse(jobs: CronJob[]) {
  return cronListResponseFixture({
    jobs,
    snapshotRevision: jobs.length > 0 ? "cron-remove-present" : "cron-remove-empty",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  });
}

async function chooseRemove(page: Page) {
  const menu = page.locator("wa-dropdown.cron-job-menu").first();
  await menu.locator(".cron-job-menu__trigger").click();
  await menu.locator('wa-dropdown-item[value="remove"]').click();
}

suite.define(() => {
  it("reveals a restored task below the initial inventory viewport", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1_280 } },
      async ({ page }) => {
        const jobs = Array.from({ length: 30 }, (_, index) => ({
          ...job,
          id: `digest-${index}`,
          name: `Digest ${index}`,
        }));
        await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponse(jobs),
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        const task = page.locator('[data-test-id="cron-row-digest-29"] .cron-table__name');
        await task.waitFor({ state: "visible", timeout: 10_000 });
        expect(
          await task.evaluate((element) => element.getBoundingClientRect().top),
        ).toBeGreaterThan(900);
        await task.focus();
        await page.keyboard.press("Enter");
        await page.locator('[data-test-id="cron-back"]').waitFor({ state: "visible" });
        await page.keyboard.press("Enter");
        await task.waitFor({ state: "visible" });
        expect(await task.evaluate((element) => element === document.activeElement)).toBe(true);
        await expect
          .poll(() =>
            task.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              // Chromium rounds scroll offsets to CSS pixels.
              return bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1;
            }),
          )
          .toBe(true);
      },
    );
  });

  it("keeps keyboard focus through task detail, Back, and selected-task removal", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const nextJob = { ...job, id: "morning-digest", name: "Morning digest" };
        const urgentJob: CronJob = {
          ...job,
          id: "failed-digest",
          name: "Failed digest",
          state: { lastRunStatus: "error" },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponse([job, nextJob, urgentJob]),
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, jobs: 3, nextWakeAtMs: null },
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        const task = page.locator(`[data-test-id="cron-row-${job.id}"] .cron-table__name`);
        await task.waitFor({ state: "visible", timeout: 10_000 });
        // Active failures move ahead of the Gateway order; restore the visual neighbor.
        expect(await page.locator(".cron-table__row").first().getAttribute("data-test-id")).toBe(
          `cron-row-${urgentJob.id}`,
        );
        await task.focus();
        await page.keyboard.press("Enter");
        const back = page.locator('[data-test-id="cron-back"]');
        await back.waitFor({ state: "visible" });
        expect(await back.evaluate((element) => element === document.activeElement)).toBe(true);

        await page.keyboard.press("Enter");
        await task.waitFor({ state: "visible" });
        expect(await task.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.keyboard.press("Enter");
        await back.waitFor({ state: "visible" });
        await chooseRemove(page);
        const confirmation = await waitForConfirmModal(page);
        await gateway.setMethodResponse("cron.list", cronListResponse([nextJob, urgentJob]));
        await confirmation.getByRole("button", { name: "Remove" }).click();
        const nextTask = page.locator(`[data-test-id="cron-row-${nextJob.id}"] .cron-table__name`);
        await nextTask.waitFor({ state: "visible" });
        expect(await nextTask.evaluate((element) => element === document.activeElement)).toBe(true);
        expect((await gateway.getRequests("cron.remove"))[0]?.params).toEqual({ id: job.id });

        await page.keyboard.press("Enter");
        await back.waitFor({ state: "visible" });
        await chooseRemove(page);
        const lastConfirmation = await waitForConfirmModal(page);
        await gateway.setMethodResponse("cron.list", cronListResponse([urgentJob]));
        await lastConfirmation.getByRole("button", { name: "Remove" }).click();
        const previousTask = page.locator(
          `[data-test-id="cron-row-${urgentJob.id}"] .cron-table__name`,
        );
        await previousTask.waitFor({ state: "visible" });
        expect(await previousTask.evaluate((element) => element === document.activeElement)).toBe(
          true,
        );
        await page.keyboard.press("Enter");
        await back.waitFor({ state: "visible" });
        await chooseRemove(page);
        const emptyConfirmation = await waitForConfirmModal(page);
        await gateway.setMethodResponse("cron.list", cronListResponse([]));
        await emptyConfirmation.getByRole("button", { name: "Remove" }).click();
        const inventory = page.locator('.cron-search-box input[type="search"]');
        await inventory.waitFor({ state: "visible" });
        expect(await inventory.evaluate((element) => element === document.activeElement)).toBe(
          true,
        );
        expect(await gateway.getRequests("cron.remove")).toHaveLength(3);
      },
    );
  });

  it("confirms removal and rejects a decision captured before reconnect", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponse([job]),
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}cron`);
        expect(response?.status()).toBe(200);
        const row = page.locator(`[data-test-id="cron-row-${job.id}"]`);
        await row.waitFor({ state: "visible", timeout: 10_000 });
        expect(await page.locator(".cron-table__head").getAttribute("role")).toBeNull();
        expect(await row.getAttribute("role")).toBeNull();
        const openTask = row.locator("button.cron-table__name");
        await openTask.focus();
        await page.keyboard.press("Enter");
        const detail = page.locator('.cron-page[data-panel-mode="job"]');
        await detail.waitFor({ state: "visible" });

        await chooseRemove(page);
        const cancelled = await waitForConfirmModal(page);
        await expect(cancelled.textContent()).resolves.toContain(job.name);
        await expect(cancelled.textContent()).resolves.toContain("permanently deletes");
        await expect(cancelled.textContent()).resolves.toContain("stops all future runs");
        expect(await cancelled.getByRole("checkbox").count()).toBe(0);
        await expect.poll(async () => gateway.getRequests("cron.remove")).toHaveLength(0);
        await cancelled.getByRole("button", { name: "Cancel" }).click();
        await expect.poll(async () => gateway.getRequests("cron.remove")).toHaveLength(0);
        await detail.waitFor({ state: "visible" });
        await expect
          .poll(() => detail.locator(".cron-detail-title").textContent())
          .toContain(job.name);

        await chooseRemove(page);
        const stale = await waitForConfirmModal(page);
        const socketCount = await gateway.getSocketCount();
        await gateway.closeLatest(1012, "Reconnect during automation removal confirmation");
        await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
        await stale.getByRole("button", { name: "Remove" }).click();
        await expect.poll(async () => gateway.getRequests("cron.remove")).toHaveLength(0);
        await row.waitFor({ state: "visible", timeout: 10_000 });

        await chooseRemove(page);
        const stable = await waitForConfirmModal(page);
        const remove = stable.getByRole("button", { name: "Remove" });
        await expect.poll(() => remove.getAttribute("class")).toContain("danger");
        await gateway.setMethodResponse("cron.list", cronListResponse([]));
        await remove.click();

        await expect.poll(async () => gateway.getRequests("cron.remove")).toHaveLength(1);
        expect((await gateway.getRequests("cron.remove"))[0]?.params).toEqual({ id: job.id });
        await expect.poll(() => row.count()).toBe(0);
      },
    );
  });
});
