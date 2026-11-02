import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron removal mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const job = cronJob("nightly-digest", "Nightly digest", {
  createdAtMs: Date.parse("2026-08-11T08:00:00.000Z"),
  updatedAtMs: Date.parse("2026-08-11T08:05:00.000Z"),
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Summarize the overnight activity" },
});

const cronListResponse = (jobs: (typeof job)[]) =>
  cronListResponseFixture(
    cronList(jobs, jobs.length ? "cron-remove-present" : "cron-remove-empty"),
  );

async function chooseRemove(page: Page) {
  const menu = page.locator(".cron-job-menu").first();
  await menu.locator(".cron-job-menu__trigger").click();
  await menu.locator('[data-value="remove"]').click();
}

suite.define(() => {
  it("confirms removal and rejects a decision captured before reconnect", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
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
      expect(await row.getAttribute("role")).toBe("listitem");
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
      await waitForControlUiGatewayReady(page);
      await detail.waitFor({ state: "visible", timeout: 10_000 });
      expect(await detail.locator(".cron-detail-title").textContent()).toContain(job.name);

      await chooseRemove(page);
      const stable = await waitForConfirmModal(page);
      const remove = stable.getByRole("button", { name: "Remove" });
      await expect.poll(() => remove.getAttribute("class")).toContain("danger");
      await gateway.setMethodResponse("cron.list", cronListResponse([]));
      await remove.click();

      await expect.poll(async () => gateway.getRequests("cron.remove")).toHaveLength(1);
      expect((await gateway.getRequests("cron.remove"))[0]?.params).toEqual({ id: job.id });
      await detail.waitFor({ state: "detached" });
      await expect.poll(() => row.count()).toBe(0);
    });
  });
});
