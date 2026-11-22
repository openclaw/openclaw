import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { configResponse } from "./chat-flow-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createUpdateRunFixture } from "./update-run.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI update run E2E" });

function text(root: Page | Locator, value: string, exact = true) {
  return root.getByText(value, { exact });
}

suite.define(() => {
  it("keeps an app update in the top-right toast across phases and reconnect", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        const initial = createUpdateRunFixture();
        const run = {
          ...initial,
          origin: { ...initial.origin, noticeSurface: "app" as const },
          phase: "requested" as const,
        } satisfies typeof initial;
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          methodResponses: { "update.status": { activeRun: run }, "update.runs.get": { run } },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const toast = page.locator(".app-toast-lane--top-right .app-toast");
        await toast.getByText("Preparing OpenClaw update…").waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, "update-toast-waiting.png"),
          animations: "disabled",
        });
        const running = { ...run, phase: "staging", updatedAtMs: run.updatedAtMs + 1 } as const;
        await gateway.setMethodResponse("update.runs.get", { run: running });
        await gateway.emitGatewayEvent("update.run.changed", running);
        await toast.getByText("Staging", { exact: true }).waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, "update-toast-processing.png"),
          animations: "disabled",
        });
        const failed = {
          ...running,
          phase: "finished",
          status: "failed",
          reason: "preflight-no-good-commit",
          updatedAtMs: running.updatedAtMs + 1,
        } as const;
        await gateway.setMethodResponse("update.runs.get", { run: failed });
        await gateway.setMethodResponse("update.status", { lastRun: failed });
        await gateway.closeLatest();
        await toast.getByText("OpenClaw update failed").waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, "update-toast-failed.png"),
          animations: "disabled",
        });
        await page.clock.install();
        await page.clock.fastForward(60_000);
        await toast.getByText("OpenClaw update failed").waitFor();
        await toast.getByRole("button", { name: "Dismiss" }).click();
        await toast.waitFor({ state: "detached" });
        await page.goto(`${suite.server.baseUrl}settings/updates`);
        await page.locator('openclaw-update-run-view [data-run-status="failed"]').waitFor();
        expect(await toast.count()).toBe(0);
      },
    );
  });

  it("keeps an unread update failure in the Inbox after the Gateway build changes", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        const run = {
          ...createUpdateRunFixture(),
          phase: "finished",
          status: "failed",
          reason: "post-update-failed",
          target: { kind: "git", channel: "dev", sha: "b".repeat(40) },
          before: { version: "2026.11.5", buildId: "before-build" },
          after: { version: "2026.11.5", buildId: "after-build", sha: "b".repeat(40) },
          steps: [{ step: "verifying", status: "failed" }],
          verification: {
            versionMatch: false,
            serviceRunning: true,
            runningVersion: "2026.11.5",
            runningBuildId: "before-build",
          },
          finishedAtMs: Date.now(),
        } as const;
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          serverVersion: "2026.11.5",
          serverBuildId: "before-build",
          gatewayBootId: "gateway-boot",
          presenceUsers: [{ self: true, id: "alice", name: "Alice" }],
          controlUiBuildSource: "configured",
          updateAvailable: null,
          methodResponses: {
            "update.status": { lastRun: run },
            "update.runs.get": { run },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("update.status");
        const inbox = page.locator(".sidebar-issues-button:visible");
        const card = page.locator('[data-attention-kind="updateAvailable"]');
        await inbox.click();
        await card
          .getByText(/OpenClaw update failed/)
          .first()
          .waitFor();

        const connections = (await gateway.getRequests("connect")).length;
        await gateway.setServerBuildId("after-build");
        await gateway.closeLatest();
        await gateway.waitForRequest("connect", { after: connections });
        const historical = page.getByRole("link", {
          name: /Last update run failed.*serving build after-build/,
        });
        await historical.waitFor();

        await gateway.emitGatewayEvent("update.available", {
          updateAvailable: {
            channel: "stable",
            currentVersion: "2026.11.5",
            latestVersion: "2026.11.6",
          },
        });
        const release = page.locator(
          'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
        );
        await release.getByText("Update available", { exact: true }).waitFor();
        await release.locator("summary").hover();
        await release
          .getByRole("button", { name: "Dismiss Update available", exact: true })
          .click();
        await release.waitFor({ state: "detached" });
        await historical.click();
        await page.waitForURL("**/settings/updates");
        const report = page.locator('openclaw-update-run-view [data-run-status="failed"]');
        await report
          .getByRole("status")
          .filter({ hasText: /Last update run failed/ })
          .waitFor();
        await report
          .getByText("The Gateway is now serving the update target.", { exact: true })
          .waitFor();
        const verification = report.getByRole("list", {
          name: "Verification at the time of the update",
        });
        expect(
          await verification.locator('[data-oracle="version"]').getAttribute("data-state"),
        ).toBe("fail");
        expect(await page.getByRole("button", { name: "Retry update", exact: true }).count()).toBe(
          0,
        );
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
      },
    );
  });

  it.each([
    ["installed ahead", "2026.10.1", "2026.9.4", "2026.9.4", false],
    ["serving moved", "2026.9.4", "2026.10.1", "2026.9.4", true],
    ["installed ahead, no observation", "2026.10.1", "2026.9.4", undefined, false],
    ["newer Gateway, no observation", "2026.9.4", "2026.10.1", undefined, false],
  ] as const)(
    "projects saved update failures: %s",
    async (_name, installed, serverVersion, recorded, historical) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 1200, width: 1440 } },
        async ({ page }) => {
          const run = {
            ...createUpdateRunFixture(),
            phase: "finished",
            status: "failed",
            reason: "preflight-no-good-commit",
            before: { version: installed, sha: "37ea9f110bad" },
            after: {},
            verification: recorded ? { serviceRunning: true, runningVersion: recorded } : {},
            target: { kind: "git", channel: "dev" },
            finishedAtMs: Date.now(),
            origin: { nextAction: "Run openclaw update." },
          } as const;
          const schedule = {
            channel: "dev",
            autoEnabled: false,
            install: { kind: "git", git: { status: "current" } },
          } as const;
          const gateway = await installMockGateway(page, {
            communityInvite: false,
            serverVersion,
            controlUiBuildSource: "configured",
            updateAvailable: null,
            updateSchedule: schedule,
            methodResponses: {
              "config.get": configResponse(
                { update: { channel: "dev", auto: { enabled: false } } },
                "historical-update",
              ),
              "update.status": { lastRun: run, schedule },
              "update.runs.get": { run },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/updates`);
          await gateway.waitForRequest("update.status");
          const surface = page.locator("openclaw-update-run-view");
          await surface
            .getByText(historical ? /Last update run failed/ : /OpenClaw update failed/)
            .first()
            .waitFor();
          expect(
            await page.getByRole("button", { name: "Retry update", exact: true }).count(),
          ).toBe(historical ? 0 : 1);
          if (historical) {
            expect(await surface.textContent()).not.toContain("Run openclaw update.");
          }
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
            animations: "disabled",
            scrollTo: surface,
          });
          await writeFile(
            path.join(
              suite.artifactDir,
              `${installed}-${serverVersion}-${recorded ?? "unknown"}.png`,
            ),
            frame.png,
          );
        },
      );
    },
  );

  it("labels a standalone repair and keeps the failed update it repaired visible", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 1200, width: 1440 } },
      async ({ page }) => {
        const now = Date.now();
        const failure =
          "Update 2b6f7c1e-9a41-4c2d-8f3e-5d6a7b8c9d0e to 2026.11.5 failed at activating: post-update-failed. finalize:doctor: SQLite migration publication could not be verified: database is locked";
        const run = {
          ...createUpdateRunFixture(),
          trigger: "cli",
          phase: "finished",
          status: "succeeded",
          reason: null,
          target: { kind: "package", version: "2026.11.5" },
          before: {},
          after: { version: "2026.11.5" },
          verification: {},
          finishedAtMs: now,
          steps: [
            {
              step: "requested",
              status: "completed",
              startedAtMs: now - 60_000,
              endedAtMs: now - 59_000,
            },
            {
              step: "repairing",
              status: "completed",
              startedAtMs: now - 59_000,
              endedAtMs: now - 1_000,
            },
            {
              step: "finalize:repaired-run",
              status: "completed",
              endedAtMs: now - 59_000,
              detail: failure,
            },
            { step: "finalize:doctor", status: "completed", endedAtMs: now - 2_000 },
          ],
        } as const;
        const schedule = {
          channel: "stable",
          autoEnabled: false,
          install: { kind: "package" },
        } as const;
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          serverVersion: "2026.11.5",
          updateAvailable: null,
          updateSchedule: schedule,
          methodResponses: {
            "config.get": configResponse(
              { update: { channel: "stable", auto: { enabled: false } } },
              "repair-run",
            ),
            "update.status": { lastRun: run, schedule },
            "update.runs.get": { run },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/updates`);
        await gateway.waitForRequest("update.status");
        const surface = page.locator("openclaw-update-run-view");
        await surface.locator(".update-run-view__report").waitFor();
        const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
          animations: "disabled",
          scrollTo: surface,
        });
        await writeFile(path.join(suite.artifactDir, "repair-run.png"), frame.png);

        await text(surface, "✅ OpenClaw repair completed for 2026.11.5.").first().waitFor();
        await text(surface, `Repaired update: ${failure}`).waitFor();
        expect(await surface.textContent()).not.toContain("OpenClaw updated to");
        const phases = surface.locator(".update-run-view__phases > li");
        expect(await phases.evaluateAll((items) => items.map((item) => item.dataset.step))).toEqual(
          ["requested", "repairing", "finished"],
        );
        await text(surface, "3 of 3 phases complete").waitFor();
      },
    );
  });

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

        await dialog
          .locator("openclaw-modal-actions")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await dialog.waitFor({ state: "detached" });
        await text(page.locator("openclaw-update-run-view"), headline).first().waitFor();
        await page.locator(".update-run-view__report").scrollIntoViewIfNeeded();
      },
    );
  });
});
