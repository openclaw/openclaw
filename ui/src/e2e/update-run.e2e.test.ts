import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { configResponse } from "./chat-flow-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createUpdateRunFixture } from "./update-run.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI update run E2E" });

function text(root: Page | Locator, value: string, exact = true) {
  return root.getByText(value, { exact });
}

suite.define(() => {
  it("requires confirmation and keeps long update output keyboard accessible", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1100, width: 1440 },
      },
      async ({ page }) => {
        let run = createUpdateRunFixture();
        run.steps.push(
          ...Array.from({ length: 24 }, (_, index) => ({
            step: `verify-plugin-example-${index + 1}`,
            status: "completed" as const,
          })),
        );
        const config = { update: { auto: { enabled: false }, channel: "stable" } };
        const settings = configResponse(config, "update-run-config");
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          agentModel: "openai/gpt-5.6-luna",
          models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" }],
          updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
          methodResponses: {
            "config.get": settings,
            "update.run": { ok: true, runId: run.runId, result: { status: "ok" } },
            "update.runs.get": { run },
            "update.status": { activeRun: null, lastRun: null },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/updates`);
        await gateway.waitForRequest("config.get");
        await page.getByRole("button", { name: "Update Gateway…", exact: true }).click();
        const dialog = page.locator("openclaw-modal-dialog");
        await dialog.getByRole("button", { name: "Update and restart", exact: true }).waitFor();
        expect(await gateway.getRequests("update.run")).toHaveLength(0);

        await dialog.getByRole("button", { name: "Update and restart", exact: true }).click();
        await gateway.waitForRequest("update.run");
        expect((await gateway.waitForRequest("update.runs.get")).params).toEqual({
          runId: run.runId,
        });
        const runView = dialog.locator("openclaw-update-run-view");
        const runDetails = runView.locator(".update-run-view__details");
        await text(runView, "⬆️ OpenClaw update in progress: staging.").waitFor();
        await text(runDetails, "Downloading the update package.", false).waitFor();
        const installationSteps = runView.locator(".update-run-view__step-list");
        await installationSteps.locator(":scope > summary").click();

        const stepList = installationSteps.locator("ol");
        await page.waitForFunction(
          (list) => list && list.scrollHeight - list.scrollTop - list.clientHeight < 2,
          await stepList.elementHandle(),
        );
        const summaryBox = await installationSteps.locator(":scope > summary").boundingBox();
        const listBox = await stepList.boundingBox();
        expect(summaryBox!.y + summaryBox!.height).toBeLessThanOrEqual(listBox!.y + 1);
        await installationSteps.locator(":scope > summary").click();
        expect(await installationSteps.getAttribute("open")).toBeNull();
        await installationSteps.locator(":scope > summary").press("Enter");
        expect(await installationSteps.getAttribute("open")).not.toBeNull();
        const details = runView.locator(".update-run-view__diagnostics");
        await details.locator("summary").click();
        expect(await details.getAttribute("open")).toBeNull();
        await details.locator("summary").press("Enter");
        expect(await details.getAttribute("open")).not.toBeNull();

        const finishedAtMs = run.updatedAtMs + 1000;
        run = {
          ...run,
          phase: "finished",
          status: "succeeded",
          updatedAtMs: finishedAtMs,
          finishedAtMs,
          confirmedAtMs: finishedAtMs,
          downtimeMs: 1000,
          after: { version: "2.0.0" },
          steps: [
            ...run.steps.map((step) => ({ ...step, status: "completed" as const })),
            ...Array.from({ length: 3 }, (_, index) => ({
              step: `warning:doctor:${index + 1}`,
              status: "completed" as const,
              detail: `Integration ${index + 1}: ${"An optional integration needs attention. Review its configuration in Settings. ".repeat(6)}`,
            })),
          ],
          verification: {
            booted: true,
            serviceRunning: true,
            runningVersion: "2.0.0",
            versionMatch: true,
            pluginErrors: [],
            channelsReady: true,
          },
        };
        await gateway.setMethodResponse("update.runs.get", { run });
        await gateway.setMethodResponse("update.status", { activeRun: null, lastRun: run });
        await gateway.emitGatewayEvent("update.run.changed", {
          runId: run.runId,
          phase: run.phase,
          status: run.status,
          updatedAtMs: run.updatedAtMs,
        });
        const headline = "✅ OpenClaw updated to 2.0.0 (from 1.0.0); 3 warnings need attention.";
        await text(runView, headline).first().waitFor();
        await text(runView, "Gateway downtime: 1s.", false).waitFor();
        expect(await runView.locator('[data-oracle][data-state="pass"]').count()).toBe(4);

        const reportBody = runView.locator(".update-run-view__report-body");
        const reportMetrics = await reportBody.evaluate((element) => ({
          height: element.clientHeight,
          contentHeight: element.scrollHeight,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        }));
        expect(reportMetrics.height).toBeCloseTo(reportMetrics.lineHeight * 6, 0);
        expect(reportMetrics.contentHeight).toBeGreaterThan(reportMetrics.height);
        await reportBody.focus();
        await reportBody.press("End");
        await page.waitForFunction(
          (report) => report && report.scrollTop > 0,
          await reportBody.elementHandle(),
        );
        expect(await gateway.getRequests("update.run")).toHaveLength(1);

        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await text(page.locator("openclaw-update-run-view"), headline).first().waitFor();
        await page.locator(".update-run-view__report").scrollIntoViewIfNeeded();
      },
    );
  });
});
