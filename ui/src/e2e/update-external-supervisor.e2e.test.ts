import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI external supervisor update E2E" });
const config = { update: { auto: { enabled: false }, channel: "stable" } };
const configResponse = {
  config,
  hash: "external-update-config",
  raw: JSON.stringify(config),
  runtimeConfig: config,
  valid: true,
  issues: [],
};

function button(root: Page | Locator, name: string) {
  return root.getByRole("button", { name, exact: true });
}

suite.define(() => {
  it("explains the refused update in the dialog and retained Settings report", async () => {
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1440, height: 1100 } },
      async ({ page }) => {
        const reason = "external-supervisor-update-required";
        const run = createUpdateRunFixture({
          phase: "finished",
          status: "skipped",
          reason,
          origin: { doctorHint: "Run openclaw doctor --non-interactive" },
          before: { version: "2026.8.1" },
          after: {},
          steps: [],
          verification: { serviceRunning: true, runningVersion: "2026.8.1" },
        });
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          agentModel: "openai/gpt-5",
          models: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }],
          updateAvailable: {
            channel: "stable",
            currentVersion: "2026.8.1",
            latestVersion: "2026.9.1",
          },
          methodResponses: {
            "config.get": configResponse,
            "update.status": { activeRun: null, lastRun: null },
            "update.run": {
              ok: false,
              runId: run.runId,
              result: { status: "skipped", reason },
              restart: null,
            },
            "update.runs.get": { run },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/updates`);
        await gateway.waitForRequest("config.get");
        await button(page, "Update now").click();
        const dialog = page.locator("openclaw-modal-dialog");
        await button(dialog, "Update and restart").click();
        await gateway.waitForRequest("update.run");
        const report = dialog.locator(".update-run-view__report");
        await report
          .getByText(`ℹ️ OpenClaw update skipped: ${reason}.`, { exact: false })
          .waitFor();
        const reportText = await report.textContent();
        expect(reportText).toContain("Use your server or deployment's update workflow");
        expect(reportText).toContain("No package changes or Gateway restart were attempted");
        expect(reportText).not.toContain("openclaw doctor");
        expect(await button(dialog, "Retry update").count()).toBe(0);
        await button(dialog, "Close").click();
        await dialog.waitFor({ state: "detached" });
        const savedReport = page.locator(".update-run-view__report");
        await savedReport
          .getByText("Use your server or deployment's update workflow", { exact: false })
          .waitFor();
        await savedReport.scrollIntoViewIfNeeded();
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
        expect(await gateway.getRequests("update.report")).toHaveLength(0);
        expect(await button(page, "Retry update").count()).toBe(0);
        expect(await page.locator("#config-section-update").textContent()).not.toMatch(
          /CLI fallback|openclaw triage/,
        );
        expect(await button(page, "Report update failure").count()).toBe(0);

        const readsBeforeFailure = (await gateway.getRequests("update.runs.get")).length;
        await gateway.deferNext("update.runs.get");
        await gateway.emitGatewayEvent("update.run.changed", {
          runId: run.runId,
          updatedAtMs: run.updatedAtMs + 1,
        });
        await gateway.waitForRequest("update.runs.get", { after: readsBeforeFailure });
        await gateway.rejectDeferred("update.runs.get", {
          code: "UNAVAILABLE",
          message: "Update status is temporarily unavailable",
        });
        const settings = page.locator("#config-section-update");
        await settings
          .getByText("Update status is temporarily unavailable", { exact: false })
          .waitFor();
        const checkStatus = button(settings, "Check status");
        await checkStatus.waitFor();
        expect(await checkStatus.isDisabled()).toBe(false);
        expect(await button(settings, "Retry update").count()).toBe(0);
        expect(await button(settings, "Report update failure").count()).toBe(0);
        expect(await settings.textContent()).not.toContain("openclaw triage");
        await checkStatus.scrollIntoViewIfNeeded();
        const statusChecksBeforeRecovery = (await gateway.getRequests("update.status")).length;
        await gateway.setMethodResponse("update.status", {
          activeRun: null,
          lastRun: { ...run, updatedAtMs: run.updatedAtMs + 1 },
        });
        await checkStatus.click();
        await gateway.waitForRequest("update.status", { after: statusChecksBeforeRecovery });
        await settings
          .getByText("Update status is temporarily unavailable", { exact: false })
          .waitFor({ state: "detached" });
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
      },
    );
  });

  it("keeps a retained external supervisor sentinel actionable without failure recovery", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        communityInvite: false,
        agentModel: "openai/gpt-5",
        models: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }],
        methodResponses: {
          "config.get": configResponse,
          "update.status": {
            sentinel: {
              kind: "update",
              status: "skipped",
              ts: 10,
              stats: { reason: "external-supervisor-update-required" },
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/updates`);
      await gateway.waitForRequest("update.status");
      const settings = page.locator("#config-section-update");
      await settings
        .getByText("Use your server or deployment's update workflow", { exact: false })
        .waitFor();
      expect(await button(settings, "Retry update").count()).toBe(0);
      expect(await settings.textContent()).not.toMatch(/CLI fallback|openclaw triage/);
      expect(await gateway.getRequests("update.run")).toHaveLength(0);
    });
  });
});
