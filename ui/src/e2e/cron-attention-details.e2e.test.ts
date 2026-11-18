import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture, createCronRunsResult } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Automation attention arrival",
  startServerBeforeBrowser: true,
});
const startedAt = Date.UTC(2026, 9, 22, 23, 41, 34);
const failure =
  "The provider stopped returning output after downloading the current release checklist. Authentication completed, the checklist was read, and the request was accepted, but the final response never arrived. Some tool actions may already have completed; inspect the saved execution record before retrying to avoid repeating those actions.";
const diagnostic =
  "The request reached the provider, then exceeded the response deadline after 604 seconds. Delivery was not requested; no final answer was recorded. Trace: " +
  "providertrace".repeat(24);
const desktop = { width: 1280, height: 900 };

suite.define(() => {
  it.each([
    { name: "desktop", viewport: desktop, colorScheme: "light" as const, maxHeight: 96 },
    { name: "dark", viewport: desktop, colorScheme: "dark" as const, maxHeight: 96 },
    {
      name: "phone",
      viewport: { width: 390, height: 844 },
      colorScheme: "light" as const,
      maxHeight: 140,
    },
  ])(
    "explains the failed run on arrival and while editing on $name",
    async ({ name, viewport, colorScheme, maxHeight }) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport, colorScheme },
        async ({ page }) => {
          const job = cronJob("attention-example", "Finish the release checklist", {
            enabled: false,
            configRevision: "synthetic-attention",
            schedule: { kind: "at", at: new Date(startedAt).toISOString() },
            payload: {
              kind: "agentTurn",
              message:
                "Verify the existing release before continuing. Do not repeat completed actions.",
            },
            sessionTarget: "isolated",
            delivery: { mode: "none" },
            state: {
              lastRunAtMs: startedAt,
              lastRunStatus: "error",
              lastError: failure,
              lastDiagnosticSummary: diagnostic,
              lastDurationMs: 604282,
              autoDisabled: {
                reason: "consecutive-failures",
                atMs: startedAt + 604282,
                consecutiveErrors: 1,
              },
            },
          });
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "cron.list": cronListResponseFixture(cronList([job], "attention-snapshot")),
              "cron.get": job,
              "cron.status": { enabled: true, jobs: 1, triggersEnabled: true },
              "cron.runs": createCronRunsResult(
                name === "phone"
                  ? []
                  : [
                      {
                        jobId: job.id,
                        jobName: job.name,
                        ts: startedAt + 604282,
                        action: "finished",
                        status: "error",
                        runId: "recorded-failure",
                        runAtMs: startedAt,
                        durationMs: 604282,
                        error: failure,
                        deliveryStatus: "not-requested",
                      },
                    ],
              ),
            },
          });
          // Same job-only deep link used by the session Details attention row.
          await page.goto(suite.server.baseUrl + "cron?job=" + job.id);
          const history = page.locator("[data-test-id=cron-detail-tab-history]");
          await expect.poll(() => history.getAttribute("aria-selected")).toBe("true");
          const attention = page.locator(".cron-failure-details");
          await attention.waitFor();
          const review = attention.locator("[data-test-id=cron-review-failed-run]");
          const cause = attention.locator(".cron-failure-details__cause");
          const clipped = () =>
            cause.evaluate((element) => element.scrollHeight > element.clientHeight);
          const fitsViewport = () =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
          expect(await cause.textContent()).toContain(failure);
          expect(await cause.textContent()).toContain(diagnostic);
          expect(await clipped()).toBe(false);
          expect(
            await cause.evaluate((element) => element.scrollWidth <= element.clientWidth),
          ).toBe(true);
          expect(await fitsViewport()).toBe(true);
          // History already exposes the saved job's full cause, even without a retained run.
          expect(await review.count()).toBe(0);
          expect(await page.locator(".cron-detail-header").textContent()).not.toContain("Paused");
          if (name === "phone") {
            expect(await page.locator(".cron-run-entry").count()).toBe(0);
          } else {
            expect(await page.locator(".cron-run-entry").textContent()).toContain(failure);
          }
          await page.locator("[data-test-id=cron-detail-tab-settings]").click();
          const prompt = page.locator(".cron-tab-panel textarea").first();
          const draft = "Keep this unsaved release instruction while reviewing the failure.";
          await prompt.fill(draft);
          expect(await clipped()).toBe(true);
          expect((await attention.boundingBox())?.height).toBeLessThan(maxHeight);
          await review.click();
          await expect.poll(() => history.getAttribute("aria-selected")).toBe("true");
          expect(await clipped()).toBe(false);
          await page.locator("[data-test-id=cron-detail-tab-settings]").click();
          expect(await prompt.inputValue()).toBe(draft);
          expect(await fitsViewport()).toBe(true);
          expect(await gateway.getRequests("cron.run")).toHaveLength(0);
          expect(await gateway.getRequests("cron.update")).toHaveLength(0);
        },
      );
    },
  );
});
