// Control UI tests cover the routed Updates settings page through a mocked Gateway.
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Updates settings mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const pageOptions = {
  colorScheme: "dark",
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1280 },
} as const;
const configResponse = (config: object, hash: string) => ({
  config,
  hash,
  issues: [],
  raw: JSON.stringify(config),
  runtimeConfig: config,
  valid: true,
});
async function expectRadiosDisabled(page: Page) {
  expect(await page.getByRole("combobox", { name: "Release channel" }).isDisabled()).toBe(true);
}

suite.define(() => {
  it("locks update policy while an automatic apply runs and shows readable recovery guidance", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const config = { update: { auto: { enabled: true }, channel: "stable" } };
      const schedule = {
        channel: "stable",
        autoEnabled: true,
        install: { kind: "package" },
        target: { kind: "package", version: "2026.8.2" },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: ["config.get", "config.set", "update.run", "update.status"],
        methodResponses: {
          "config.get": configResponse(config, "automatic-update-config"),
          "update.status": { sentinel: null, schedule },
        },
        operatorScopes: ["operator.read", "operator.admin"],
      });
      expect((await page.goto(`${suite.server.baseUrl}settings/updates`))?.status()).toBe(200);
      await gateway.waitForRequest("update.status");
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await page.screenshot({
          animations: "disabled",
          fullPage: false,
          path: path.join(
            createControlUiE2eArtifactDir("updates-settings-proof"),
            "gateway-overview.png",
          ),
        });
      }
      const policy = page.getByRole("switch", { name: "Automatic updates" });
      const checks = page.getByRole("switch", { name: "Check automatically" });
      await policy.waitFor();
      await expect.poll(() => policy.isDisabled()).toBe(false);

      const now = Date.now();
      await gateway.emitGatewayEvent("update.available", {
        schedule: {
          ...schedule,
          campaign: {
            id: "campaign-automatic",
            state: "applying",
            announcedAtMs: now - 60_000,
            holdUntilMs: now + 3_600_000,
            forceAtMs: now + 4_500_000,
            updatedAtMs: now,
          },
        },
      });
      const status = page.locator("#config-section-update .settings-status");
      await expect.poll(() => status.textContent()).toMatch(/Applying update|Update held/);
      expect(await status.textContent()).toContain("Applying update");
      expect(await policy.isDisabled()).toBe(true);
      expect(await checks.isDisabled()).toBe(true);
      await expectRadiosDisabled(page);
      expect(await page.getByRole("button", { name: "Updating…", exact: true }).isDisabled()).toBe(
        true,
      );

      await gateway.setMethodResponse("update.status", {
        sentinel: {
          kind: "update",
          status: "skipped",
          ts: now,
          stats: { mode: "npm", reason: "managed-service-handoff-unavailable" },
        },
        schedule,
      });
      await gateway.emitGatewayEvent("update.available", { schedule });
      await status.filter({ hasText: "Stop the foreground Gateway" }).waitFor();
      expect(await policy.isDisabled()).toBe(false);
      expect(await checks.isDisabled()).toBe(false);
      expect(await gateway.getRequests("update.run")).toHaveLength(0);
      await status.scrollIntoViewIfNeeded();
      const geometry = await status.evaluate((element) => {
        const card = element.closest('section[aria-label="Update status"]');
        if (!card) {
          throw new Error("Missing compact update status card");
        }
        const bounds = element.getBoundingClientRect();
        const cardBounds = card.getBoundingClientRect();
        return {
          insideCard: bounds.left >= cardBounds.left && bounds.right <= cardBounds.right,
          overflows: element.scrollWidth > element.clientWidth,
        };
      });
      expect(geometry).toEqual({ insideCard: true, overflows: false });
    });
  });

  it("resumes disabled update checks through autosave and renders the live campaign", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const config = {
        update: { auto: { enabled: true }, channel: "stable", checkOnStart: false },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: ["config.get", "config.set", "config.apply", "update.run"],
        methodResponses: {
          "config.get": configResponse(config, "updates-config-1"),
          "update.run": {
            ok: false,
            result: { reason: "restart-disabled", status: "skipped" },
          },
        },
        operatorScopes: ["operator.read", "operator.admin"],
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/updates`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("config.get");
      expect(await gateway.getRequests("config.schema")).toHaveLength(0);

      const content = page.locator("#control-ui-main");
      await content.getByText("Updates", { exact: true }).waitFor();
      const checks = content.getByRole("switch", { name: "Check automatically", exact: true });
      const automatic = content.getByRole("switch", { name: "Automatic updates", exact: true });
      await expect.poll(() => automatic.isChecked()).toBe(true);
      expect(await checks.isChecked()).toBe(false);
      expect(await automatic.isDisabled()).toBe(true);
      await content
        .locator(".settings-row__title")
        .filter({ hasText: /^Check automatically$/ })
        .click();
      const checksSaved = await gateway.waitForRequest("config.set");
      const checksRaw = (checksSaved.params as { raw?: unknown }).raw;
      expect(typeof checksRaw).toBe("string");
      expect(JSON.parse(String(checksRaw))).toMatchObject({
        update: { checkOnStart: true, channel: "stable", auto: { enabled: true } },
      });
      await expect.poll(() => automatic.isDisabled()).toBe(false);
      expect(await automatic.isChecked()).toBe(true);

      await gateway.emitGatewayEvent("update.available", {
        updateAvailable: {
          currentVersion: "2026.8.1",
          latestVersion: "2026.8.2",
          channel: "stable",
        },
        schedule: {
          channel: "stable",
          autoEnabled: true,
          install: { kind: "package" },
          target: { kind: "package", version: "2026.8.2" },
          campaign: {
            id: "campaign-e2e",
            state: "countdown",
            announcedAtMs: Date.now(),
            applyAtMs: Date.now() + 55_000,
            forceAtMs: Date.now() + 15 * 60_000,
            updatedAtMs: Date.now(),
          },
        },
      });

      const timer = content.locator("[role='timer']");
      await expect.poll(() => timer.textContent()).toContain("Updating in 0:");
      const firstCountdown = await timer.textContent();
      await expect.poll(() => timer.textContent()).not.toBe(firstCountdown);
    });
  });

  it("keeps the page readable and controls locked for non-admins", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const config = { update: { auto: { enabled: true }, channel: "beta" } };
      const gateway = await installMockGateway(page, {
        featureMethods: ["config.get", "update.run"],
        methodResponses: {
          "config.get": configResponse(config, "updates-read-only-1"),
        },
        operatorScopes: ["operator.read"],
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/updates`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("config.get");
      await page.getByRole("note").waitFor();
      expect(await page.getByRole("note").textContent()).toContain(
        "Administrator access is required",
      );
      await expectRadiosDisabled(page);
      expect(await page.getByRole("switch", { name: "Automatic updates" }).isDisabled()).toBe(true);
      expect(await page.getByRole("switch", { name: "Check automatically" }).isDisabled()).toBe(
        true,
      );
      expect(await page.getByRole("button", { name: "Update" }).isDisabled()).toBe(true);
      expect(await gateway.getRequests("config.schema")).toHaveLength(0);
    });
  });

  it.each(["light", "dark"] as const)(
    "keeps preferences visible and terminal details optional (%s)",
    async (colorScheme) => {
      await suite.withPage({ ...pageOptions, colorScheme }, async ({ page }) => {
        const run = createUpdateRunFixture({
          phase: "finished",
          status: "failed",
          reason: "build-failed",
          finishedAtMs: 500,
        });
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.write", "operator.admin"],
          methodResponses: {
            "config.get": configResponse({ update: { channel: "stable" } }, "visual-correction"),
            "update.status": {
              lastRun: run,
              activeRun: null,
              schedule: {
                channel: "stable",
                autoEnabled: false,
                install: { kind: "package" },
                target: { kind: "package", version: "2026.9.2" },
              },
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/updates`);
        await gateway.waitForRequest("update.status");
        await page.getByRole("button", { name: "View result", exact: true }).waitFor();
        const preferences = page.getByRole("heading", { name: "Preferences", exact: true });
        expect(await preferences.isVisible()).toBe(true);
        expect(await page.locator(".page-subtitle").count()).toBe(0);
        expect(await page.getByRole("combobox", { name: "Release channel" }).isVisible()).toBe(
          true,
        );
        const folder = createControlUiE2eArtifactDir(`correction-${colorScheme}`);
        await page.screenshot({ path: path.join(folder, "overview.png"), animations: "disabled" });
        await page.getByRole("button", { name: "View result", exact: true }).click();
        const dialog = page.locator("openclaw-modal-dialog");
        await dialog.getByRole("button", { name: "Diagnose", exact: true }).waitFor();
        for (const name of ["Refresh status", "Try again", "Report failure", "Diagnose"]) {
          expect(await dialog.getByRole("button", { name, exact: true }).isVisible()).toBe(true);
        }
        expect(
          await dialog
            .getByRole("heading", { name: "Couldn’t finish the update.", exact: true })
            .count(),
        ).toBe(1);
        expect(await dialog.locator(".exec-approval-title").textContent()).toBe(
          "Couldn’t finish the update.",
        );
        expect(
          await dialog.locator(".update-run-view > details > summary").allTextContents(),
        ).toEqual(["Update steps", "Technical details"]);
        expect(await dialog.locator(".update-run-view > details[open]").count()).toBe(0);
        expect(await dialog.locator(".update-run-view__phases").isVisible()).toBe(false);
        await page.screenshot({ path: path.join(folder, "result.png"), animations: "disabled" });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: path.join(folder, "result-narrow.png"),
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        await page.screenshot({
          path: path.join(folder, "overview-narrow.png"),
          animations: "disabled",
        });
        await page.setViewportSize(pageOptions.viewport);
        await gateway.setMethodResponse("update.status", {
          lastRun: null,
          activeRun: null,
          schedule: null,
          updateAvailable: null,
        });
        await page.getByRole("button", { name: "Refresh status", exact: true }).click();
        const status = page.locator('section[aria-label="Update status"] .settings-status');
        await expect.poll(() => status.textContent()).toBe("No recent update status");
        await page.getByRole("heading", { name: "Updates", exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(folder, "unknown.png"), animations: "disabled" });
        await gateway.setMethodResponse("update.status", {
          __mockError: { code: "UNAVAILABLE", message: "Status check unavailable" },
        });
        await page.getByRole("button", { name: "Refresh status", exact: true }).click();
        await expect.poll(() => status.textContent()).toContain("Status check unavailable");
        await page.getByRole("heading", { name: "Updates", exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(folder, "check-failed.png"),
          animations: "disabled",
        });
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
      });
    },
  );

  it("lets a named administrator review an update report and receive their browser handoff", async () => {
    await suite.withPage(
      {
        ...pageOptions,
        viewport: { height: 1000, width: 1400 },
      },
      async ({ page }) => {
        const run = createUpdateRunFixture({
          phase: "finished",
          status: "failed",
          reason: "build-failed",
          finishedAtMs: 500,
        });
        const body =
          "# OpenClaw update failure report\n\nFailed phase: build\nNo private logs are included.";
        const title = "Update failure: build-failed";
        const fallbackUrl = `https://github.com/openclaw/openclaw/issues/new?${new URLSearchParams({ body, title })}`;
        const config = { update: { auto: { enabled: false }, channel: "stable" } };
        const gateway = await installMockGateway(page, {
          authMethod: "trusted-proxy",
          presenceUsers: [
            {
              self: true,
              id: "11111111-2222-4333-8444-555555555555",
              name: "Example administrator",
            },
          ],
          operatorScopes: ["operator.read", "operator.write", "operator.admin"],
          methodResponses: {
            "config.get": configResponse(config, "report-config"),
            "update.status": { activeRun: null, lastRun: run },
            "update.report": {
              status: "ready",
              attemptId: run.runId,
              body,
              title,
              previewDigest: "a".repeat(64),
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/updates`);
        await gateway.waitForRequest("update.status");
        await page.getByRole("button", { name: "View result", exact: true }).click();
        const report = page.getByRole("button", { name: "Report failure", exact: true });
        await report.waitFor();
        expect(await report.isEnabled()).toBe(true);
        await report.click();
        const dialog = page.locator("openclaw-modal-dialog");
        await dialog.getByText(body, { exact: true }).waitFor();
        await gateway.setMethodResponse("update.report", {
          status: "fallback",
          fallbackUrl,
          message:
            "Review and submit the prefilled issue using your own GitHub account in your browser. No issue has been submitted by the Gateway.",
        });
        await dialog.getByRole("button", { name: "Continue", exact: true }).click();
        const link = page.locator(`a[href="${fallbackUrl}"]`);
        await link.waitFor();
        expect(await link.getAttribute("target")).toBe("_blank");
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
      },
    );
  });
});
