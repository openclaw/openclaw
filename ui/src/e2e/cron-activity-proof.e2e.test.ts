import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  cronJob,
  cronList,
  cronRuns,
  cronSidebarFeatureMethods,
  openAutomationActivity,
} from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Failed one-time automation in Activity",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("shows the failed run and its available actions", async () => {
    const stage = process.env.OPENCLAW_CRON_PROOF_STAGE ?? "after";
    const after = stage === "after";
    const artifacts = createControlUiE2eArtifactDir("cron-activity-" + stage);
    console.log("cron proof:", artifacts);
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        timezoneId: "UTC",
        locale: "en-US",
        colorScheme: "light",
      },
      async ({ page }) => {
        const started = Date.parse("2026-11-18T13:00:00Z");
        await page.clock.setFixedTime(new Date(started + 600_000));
        const failed = cronJob("build-once", "Check the staging build", {
          enabled: false,
          schedule: { kind: "at", at: new Date(started).toISOString() },
          state: { lastRunAtMs: started, lastRunStatus: "error" },
        });
        const jobs = [
          cronJob("digest", "Send the daily handoff"),
          cronJob("reminders", "Review open release tasks"),
          ...(after ? [] : [failed]),
        ];
        const gateway = await installMockGateway(page, {
          featureMethods: cronSidebarFeatureMethods,
          methodResponses: {
            "cron.list": cronList(jobs, stage),
            "cron.status": { enabled: true, jobs: jobs.length },
            "cron.runs": cronRuns([
              {
                ts: started + 12_000,
                runAtMs: started,
                durationMs: 12_000,
                action: "finished",
                jobId: failed.id,
                jobName: failed.name,
                runId: "failed-build-run",
                status: "error",
                deliveryStatus: "not-requested",
                error: "The staging build service did not respond.",
                ...(after ? { retryAvailable: true } : {}),
              },
              {
                ts: started - 3_600_000,
                action: "finished",
                jobId: "digest",
                jobName: "Send the daily handoff",
                status: "ok",
                deliveryStatus: "delivered",
                summary: "Sent the daily handoff to the release team.",
              },
            ]),
            "cron.run": { ok: true, enqueued: true, runId: "new-build-run" },
          },
        });
        await page.goto(suite.server.baseUrl + "cron");
        await openAutomationActivity(page);
        const row = page.locator(".cron-run-entry").filter({ hasText: failed.name });
        await row.getByText("The staging build service did not respond.").waitFor();
        const retry = row.getByRole("button", { name: "Retry", exact: true });
        expect(await retry.count()).toBe(after ? 1 : 0);
        const target = after ? retry : row;
        const frame = await takeControlUiScreenshotFrame(page, row, [target], {
          animations: "disabled",
          elements: [target],
        });
        writeFileSync(artifacts + "/" + stage + "-clean.png", frame.png);
        const rect = frame.elements[0]!.bounds;
        const annotation = {
          kind: "outline" as const,
          rect,
          text: after ? "Retry this one-time run" : "No retry action on the failed run",
          labelAt: { x: Math.max(25, rect.x - 160), y: rect.y - 42 },
          color: "#7c36b5",
        };
        const annotated = await rasterizeProofAnnotations(suite.browser, {
          viewport: page.viewportSize()!,
          scale: await page.evaluate(() => devicePixelRatio),
          image: frame.png,
          annotations: [annotation],
        });
        writeFileSync(artifacts + "/" + stage + "-annotated.png", annotated);
        if (after) {
          await retry.click();
          await gateway.waitForRequest("cron.run");
          expect((await gateway.getRequests("cron.run")).at(-1)?.params).toMatchObject({
            id: failed.id,
            retryRunId: "failed-build-run",
          });
        }
      },
    );
  });
});
