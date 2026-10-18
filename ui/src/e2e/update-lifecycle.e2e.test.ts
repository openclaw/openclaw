import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI update lifecycle E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const DEV_UPDATE_AVAILABLE = {
  channel: "dev",
  commitsBehind: 246,
  currentSha: "1111111111111111111111111111111111111111",
  currentVersion: "2026.8.1",
  latestVersion: "2026.8.1",
  upstreamRef: "origin/main",
  upstreamSha: "9f3c21a0000000000000000000000000000000aa",
} as const;

const DEV_UPDATE_SCHEDULE = {
  autoEnabled: false,
  channel: "dev",
  install: { kind: "git" as const, git: { status: "behind" as const, commitsBehind: 246 } },
  target: {
    kind: "git" as const,
    commitsBehind: DEV_UPDATE_AVAILABLE.commitsBehind,
    upstreamRef: DEV_UPDATE_AVAILABLE.upstreamRef,
    upstreamSha: DEV_UPDATE_AVAILABLE.upstreamSha,
  },
};

function createDevRun() {
  return createUpdateRunFixture({
    target: { kind: "git", sha: DEV_UPDATE_AVAILABLE.upstreamSha },
    before: { version: DEV_UPDATE_AVAILABLE.currentVersion, sha: DEV_UPDATE_AVAILABLE.currentSha },
    steps: [
      { step: "requested", status: "completed" },
      { step: "staging", status: "in_progress", detail: "Installing the update on the Gateway." },
    ],
  });
}

async function openUpdateConfirmation(page: Page): Promise<void> {
  await page.locator(".sidebar-identity-card").click();
  await page.locator('.sidebar-identity-menu [data-value="command:updates"]').click();
  await page.getByRole("button", { name: "Update now", exact: true }).click();
}

async function withDevUpdate(
  colorScheme: "light" | "dark",
  scenario: (
    page: Page,
    gateway: MockGatewayControls,
    run: ReturnType<typeof createDevRun>,
  ) => Promise<void>,
) {
  await suite.withPage(
    {
      colorScheme,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    },
    async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const run = createDevRun();
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "update.run": { ok: true, runId: run.runId, handoff: { status: "started" } },
          "update.runs.get": { run },
          "update.status": {
            activeRun: null,
            lastRun: null,
            updateAvailable: DEV_UPDATE_AVAILABLE,
            schedule: DEV_UPDATE_SCHEDULE,
          },
        },
      });
      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.waitForRequest("chat.startup");
      await gateway.waitForRequest("update.status");
      await gateway.emitGatewayEvent("update.available", {
        schedule: DEV_UPDATE_SCHEDULE,
        updateAvailable: DEV_UPDATE_AVAILABLE,
      });
      await openUpdateConfirmation(page);
      await scenario(page, gateway, run);
      expect(errors).toEqual([]);
    },
  );
}

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "narrates a dev-channel update through to its recorded success (%s)",
    async (colorScheme) => {
      await withDevUpdate(colorScheme, async (page, gateway, initialRun) => {
        let run = initialRun;
        const dialog = page.locator("openclaw-modal-dialog");
        const confirm = dialog.getByRole("button", { name: "Update and restart", exact: true });
        await confirm.waitFor();
        await confirm.click();

        const updating = dialog.getByRole("button", { name: "Updating…", exact: true });
        await updating.waitFor();
        expect(await updating.isEnabled()).toBe(false);
        await page
          .locator("openclaw-modal-dialog .update-run-view__details")
          .getByText("Installing the update on the Gateway.", { exact: true })
          .waitFor();
        expect(await gateway.getRequests("update.run")).toHaveLength(1);

        run = {
          ...run,
          phase: "restarting",
          updatedAtMs: run.updatedAtMs + 1,
          steps: [
            { step: "staging", status: "completed" },
            { step: "restarting", status: "in_progress" },
          ],
        };
        await gateway.setMethodResponse("update.runs.get", { run });
        await gateway.emitGatewayEvent("update.run.changed", {
          runId: run.runId,
          phase: run.phase,
          status: run.status,
          updatedAtMs: run.updatedAtMs,
        });
        await dialog
          .getByText("⬆️ OpenClaw update in progress: restarting.", { exact: true })
          .waitFor();
        await gateway.setOnline(false);
        await dialog.getByText("Gateway restarting…", { exact: true }).waitFor();
        expect(await dialog.count()).toBe(1);

        // Git installs can keep their package version while changing revision.
        // The replacement Gateway's record must remain visible until dismissal.
        run = {
          ...run,
          phase: "finished",
          status: "succeeded",
          updatedAtMs: run.updatedAtMs + 1,
          finishedAtMs: Date.now(),
          after: {
            version: DEV_UPDATE_AVAILABLE.currentVersion,
            sha: DEV_UPDATE_AVAILABLE.upstreamSha,
          },
          steps: run.steps.map((step) => ({ ...step, status: "completed" as const })),
          verification: { booted: true, serviceRunning: true, versionMatch: true },
        };
        await gateway.setMethodResponse("update.runs.get", { run });
        await gateway.setMethodResponse("update.status", { activeRun: null, lastRun: run });
        const reads = (await gateway.getRequests("update.runs.get")).length;
        await gateway.setGatewayBootId("dev-update-restarted");
        await gateway.setOnline(true);
        expect((await gateway.waitForRequest("update.runs.get", { after: reads })).params).toEqual({
          runId: run.runId,
        });
        await dialog
          .getByText("✅ OpenClaw updated to 2026.8.1 (9f3c21a0) (from 2026.8.1 (11111111)).", {
            exact: true,
          })
          .first()
          .waitFor();
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
      });
    },
  );

  it.each(["light", "dark"] as const)(
    "names the recorded cause when the install fails (%s)",
    async (colorScheme) => {
      await withDevUpdate(colorScheme, async (page, gateway, initialRun) => {
        let run = initialRun;
        const dialog = page.locator("openclaw-modal-dialog");
        await dialog.getByRole("button", { name: "Update and restart", exact: true }).click();
        await dialog.getByRole("button", { name: "Updating…", exact: true }).waitFor();
        await gateway.waitForRequest("update.runs.get");
        await gateway.setOnline(false);
        run = {
          ...run,
          phase: "finished",
          status: "failed",
          reason: "deps-install-failed",
          updatedAtMs: run.updatedAtMs + 1,
          finishedAtMs: Date.now(),
          steps: [
            { step: "fetch", status: "completed" },
            {
              step: "install",
              status: "failed",
              detail: "ENOSPC: no space left on device, write",
            },
          ],
        };
        await gateway.setMethodResponse("update.runs.get", { run });
        await gateway.setMethodResponse("update.status", { activeRun: null, lastRun: run });
        await gateway.setGatewayBootId("failed-dev-update-restarted");
        await gateway.setOnline(true);

        await dialog
          .getByText("⚠️ OpenClaw update failed: deps-install-failed.", { exact: true })
          .first()
          .waitFor();
        const failureText = await dialog.textContent();
        expect(failureText).toContain("Failed: install — ENOSPC: no space left on device, write");
        expect(failureText).toContain(
          "Run openclaw triage to diagnose and repair the failed update.",
        );
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
      });
    },
  );
});
