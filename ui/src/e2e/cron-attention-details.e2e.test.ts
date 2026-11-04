import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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
  "No answer was returned. Some tool actions may already have completed; review before retrying.";

suite.define(() => {
  it.each([
    { name: "desktop", viewport: { width: 1280, height: 900 } },
    { name: "phone", viewport: { width: 390, height: 844 } },
  ])(
    "explains the failed run on arrival and while editing on $name",
    async ({ name, viewport }) => {
      const artifactDir = createControlUiE2eArtifactDir("cron-attention-" + name);
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport },
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
              "cron.runs": createCronRunsResult([
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
              ]),
            },
          });
          // Same job-only deep link used by the session Details attention row.
          await page.goto(suite.server.baseUrl + "cron?job=" + job.id);
          await page.locator(".cron-detail-header").waitFor();
          await page.screenshot({ path: path.join(artifactDir, "arrival.png") });
          const history = page.locator("[data-test-id=cron-detail-tab-history]");
          await expect.poll(() => history.getAttribute("aria-selected")).toBe("true");
          const attention = page.locator(".cron-failure-details");
          await attention.waitFor();
          expect(await attention.getAttribute("open")).toBeNull();
          const collapsed = await attention.boundingBox();
          expect(collapsed?.height).toBeLessThan(viewport.width < 640 ? 112 : 64);
          const disclosure = attention.locator("summary");
          await disclosure.focus();
          await page.keyboard.press("Enter");
          expect(await attention.locator(".cron-failure-details__body").isVisible()).toBe(true);
          expect(await attention.locator(".cron-failure-details__cause").textContent()).toBe(
            failure,
          );
          await page.screenshot({ path: path.join(artifactDir, "expanded.png") });
          await page.keyboard.press("Enter");
          expect(await attention.getAttribute("open")).toBeNull();
          expect(await attention.textContent()).toContain(failure);
          expect(await page.locator(".cron-run-entry").textContent()).toContain(failure);
          await page.locator("[data-test-id=cron-detail-tab-settings]").click();
          expect(await attention.isVisible()).toBe(true);
          expect(await attention.textContent()).toContain(failure);
          expect(await page.locator(".cron-detail-header").textContent()).not.toContain("Paused");
          const prompt = page.locator(".cron-tab-panel textarea").first();
          const draft = "Keep this unsaved release instruction while reviewing the failure.";
          await prompt.fill(draft);
          await page.locator("[data-test-id=cron-review-failed-run]").click();
          expect(await attention.getAttribute("open")).toBeNull();
          await expect.poll(() => history.getAttribute("aria-selected")).toBe("true");
          await page.locator("[data-test-id=cron-detail-tab-settings]").click();
          expect(await prompt.inputValue()).toBe(draft);
          await page.screenshot({ path: path.join(artifactDir, "settings.png") });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          expect(await gateway.getRequests("cron.run")).toHaveLength(0);
          expect(await gateway.getRequests("cron.update")).toHaveLength(0);
        },
      );
    },
  );
});
