import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron trigger filter E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const baseJob = {
  createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
  updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
};
const conditionalJob = cronJob("conditional-job", "Conditional job", {
  ...baseJob,
  configRevision: "conditional-revision",
  payload: { kind: "systemEvent", text: "conditional" },
  trigger: { script: "json({ fire: true })" },
  state: {
    triggerEvalCount: 42,
    lastTriggerEvalAtMs: Date.now() - 3 * 60_000,
  },
});
const plainJob = cronJob("plain-job", "Plain job", {
  ...baseJob,
  configRevision: "plain-revision",
  payload: { kind: "systemEvent", text: "plain" },
});

const listResponse = (jobs: (typeof plainJob)[]) => cronList(jobs, `trigger-filter:${jobs.length}`);

suite.define(() => {
  it("shows trigger indicators and filters through cron.list before pagination", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "cron.list": cronListResponseFixture([
            { match: { lastRunStatus: "error" }, response: listResponse([]) },
            { match: { trigger: "conditional" }, response: listResponse([conditionalJob]) },
            { response: listResponse([conditionalJob, plainJob]) },
          ]),
          "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
          "cron.status": { enabled: true, triggersEnabled: false, jobs: 2, nextWakeAtMs: null },
        },
      });

      await page.goto(`${suite.server.baseUrl}cron`);
      const conditionalRow = page.locator('[data-test-id="cron-row-conditional-job"]');
      await conditionalRow.waitFor();
      await page.locator('[data-test-id="cron-row-plain-job"]').waitFor();
      expect(await conditionalRow.locator(".cron-trigger-icon").getAttribute("aria-label")).toBe(
        "Trigger configured",
      );

      await page.locator(".cron-filter-popover__trigger").click();
      await page.locator('[data-test-id="cron-jobs-trigger-filter"]').selectOption("conditional");
      await expect
        .poll(async () =>
          (await gateway.getRequests("cron.list")).some(
            (request) =>
              request.params &&
              typeof request.params === "object" &&
              "trigger" in request.params &&
              request.params.trigger === "conditional",
          ),
        )
        .toBe(true);
      await expect
        .poll(async () => page.locator('[data-test-id="cron-row-plain-job"]').count())
        .toBe(0);
      expect(await conditionalRow.count()).toBe(1);

      await conditionalRow.click();
      await page.getByRole("tab", { name: "Run history", exact: true }).click();
      const activity = page.locator('[data-test-id="cron-condition-activity"]');
      await activity.waitFor();
      await expect.poll(() => activity.textContent()).toContain("42");
      await expect.poll(() => activity.textContent()).toContain("3m ago");
      await expect.poll(() => activity.textContent()).toContain("Never");
      await expect
        .poll(() => page.locator(".cron-empty-state").textContent())
        .toContain("No payload runs yet");
    });
  });
});
