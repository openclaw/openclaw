import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { UpdateRunPhase, UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createUpdateRunFixture } from "./update-run.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI update run E2E" });

function text(root: Page | Locator, value: string, exact = true) {
  return root.getByText(value, { exact });
}

suite.define(() => {
  it("resumes the same update after restart and keeps its successful report visible", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1100, width: 1440 },
      },
      async ({ context, page }) => {
        let run = createUpdateRunFixture();
        run.steps.push(
          ...Array.from({ length: 24 }, (_, index) => ({
            step: `verify-plugin-example-${index + 1}`,
            status: "completed" as const,
          })),
          { step: "snapshot-space-preflight", status: "completed" },
          {
            step: "diagnostic:snapshot-space-preflight:8",
            status: "completed",
            detail: "Recovery backup needs 18 GiB; 32 GiB is available.",
          },
        );
        const config = { update: { auto: { enabled: false }, channel: "stable" } };
        const configResponse = {
          config,
          hash: "update-run-config",
          issues: [],
          raw: JSON.stringify(config),
          runtimeConfig: config,
          valid: true,
        };
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          agentModel: "openai/gpt-5.6-luna",
          models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" }],
          updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
          methodResponses: {
            "config.get": configResponse,
            "update.run": { ok: true, runId: run.runId, result: { status: "ok" } },
            "update.runs.get": { run },
            "update.status": { activeRun: null, lastRun: null },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/updates`);
        await gateway.waitForRequest("config.get");
        await page.getByRole("button", { name: "Update now", exact: true }).click();
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
        const repairing = runView.locator('[data-step="repairing"]');
        await text(runView, "⬆️ OpenClaw update in progress: staging.").waitFor();
        await text(runDetails, "Downloading the update package.", false).waitFor();
        expect(await repairing.count()).toBe(0);
        const installationSteps = runView.locator(".update-run-view__step-list");
        await installationSteps.locator(":scope > summary").click();

        const stepList = installationSteps.locator("ol");
        await page.waitForFunction(
          (list) => list && list.scrollHeight - list.scrollTop - list.clientHeight < 2,
          await stepList.elementHandle(),
        );
        expect(await stepList.textContent()).not.toContain("diagnostic:snapshot-space-preflight:8");
        expect(await stepList.textContent()).toContain("Checking space for the recovery backup");
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

        const advance = async (phase: UpdateRunPhase, detail: string) => {
          run = {
            ...run,
            phase,
            updatedAtMs: run.updatedAtMs + 1000,
            steps: [
              ...run.steps
                .filter((step) => step.step !== phase)
                .map((step) => Object.assign({}, step, { status: "completed" as const })),
              { step: phase, status: "in_progress", detail },
            ],
          };
          const reads = (await gateway.getRequests("update.runs.get")).length;
          await gateway.setMethodResponse("update.runs.get", { run });
          await gateway.emitGatewayEvent("update.run.changed", {
            runId: run.runId,
            phase: run.phase,
            status: run.status,
            updatedAtMs: run.updatedAtMs,
          });
          await gateway.waitForRequest("update.runs.get", { after: reads });
          await text(runDetails, detail, false).waitFor();
        };
        await advance("validating", "Package integrity and startup checks passed.");
        const snapshotDetails = runView.locator('[data-step="snapshot-space-preflight"] details');
        await snapshotDetails.locator("summary").click();
        await text(snapshotDetails, "Recovery backup needs 18 GiB; 32 GiB is available.").waitFor();
        expect(await snapshotDetails.getAttribute("open")).not.toBeNull();
        await snapshotDetails.locator("summary").click();
        expect(await snapshotDetails.getAttribute("open")).toBeNull();
        await advance("activating", "Activating the verified package.");
        await advance("restarting", "Waiting for the Gateway to reconnect.");
        await gateway.setOnline(false);
        await text(runView, "Gateway restarting…").waitFor();
        expect(await dialog.count()).toBe(1);

        run = {
          ...run,
          phase: "verifying",
          updatedAtMs: run.updatedAtMs + 1000,
          after: { version: "2.0.0" },
          steps: [
            ...run.steps.map((step) => Object.assign({}, step, { status: "completed" as const })),
            {
              step: "verifying",
              status: "in_progress",
              detail: "Checking channels and readiness.",
            },
          ],
          verification: { booted: true, serviceRunning: true, runningVersion: "2.0.0" },
        };
        await gateway.setMethodResponse("update.runs.get", { run });
        await gateway.setMethodResponse("update.status", { activeRun: run, lastRun: run });
        const readsBeforeReconnect = (await gateway.getRequests("update.runs.get")).length;
        await gateway.setGatewayBootId("update-run-restarted");
        await gateway.setOnline(true);
        expect(
          (await gateway.waitForRequest("update.runs.get", { after: readsBeforeReconnect })).params,
        ).toEqual({ runId: run.runId });
        await text(runDetails, "Checking channels and readiness.", false).waitFor();
        expect(await repairing.count()).toBe(0);

        await advance("repairing", "Repairing the installed candidate after verification failed.");
        expect(await repairing.getAttribute("data-status")).toBe("in_progress");

        await advance("verifying", "Verifying the repaired candidate.");

        const finishedAtMs = run.updatedAtMs + 1000;
        run = {
          ...run,
          phase: "finished",
          status: "succeeded",
          updatedAtMs: finishedAtMs,
          finishedAtMs,
          confirmedAtMs: finishedAtMs,
          downtimeMs: 1000,
          steps: [
            ...run.steps.map((step) => Object.assign({}, step, { status: "completed" as const })),
            ...Array.from({ length: 3 }, (_, index) => ({
              step: `warning:doctor:${index + 1}`,
              status: "completed" as const,
              detail: `Integration ${index + 1}: ${"An optional integration needs attention. Review its configuration in Settings. ".repeat(6)}`,
            })),
          ],
          verification: {
            ...run.verification,
            versionMatch: true,
            pluginErrors: [],
            channelsReady: true,
          },
        } satisfies UpdateRunRecord;
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
        expect(await repairing.getAttribute("data-status")).toBe("completed");

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

        // A fresh page has no in-memory run ID and must discover the last run from status.
        const freshPage = await context.newPage();
        const freshGateway = await installMockGateway(freshPage, {
          communityInvite: false,
          agentModel: "openai/gpt-5.6-luna",
          models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" }],
          methodResponses: {
            "update.status": { activeRun: null, lastRun: run },
            "update.runs.get": { run },
            "config.get": configResponse,
          },
        });
        await freshPage.goto(`${suite.server.baseUrl}settings/updates`);
        await freshGateway.waitForRequest("update.status");
        await text(freshPage.locator("openclaw-update-run-view"), headline).first().waitFor();
        expect(await freshGateway.getRequests("update.run")).toHaveLength(0);
        await freshPage.locator(".update-run-view__report").scrollIntoViewIfNeeded();
      },
    );
  });
});
