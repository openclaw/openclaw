// Control UI tests cover the routed Updates settings page through a mocked Gateway.
import type { Page } from "playwright";
import { expect, it } from "vitest";
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
  expect(
    await page
      .getByRole("radiogroup")
      .getByRole("radio")
      .evaluateAll(
        (radios) =>
          radios.length > 0 &&
          radios.every((radio) => radio.getAttribute("aria-disabled") === "true"),
      ),
  ).toBe(true);
}

suite.define(() => {
  it("shows an executing update ahead of a separately queued campaign", async () => {
    await suite.withPage(
      { colorScheme: "dark", viewport: { height: 1100, width: 1280 } },
      async ({ page }) => {
        const config = { update: { auto: { enabled: true }, channel: "dev" } };
        const now = Date.now();
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.get", "update.run", "update.status", "update.hold"],
          methodResponses: {
            "config.get": configResponse(config, "updates-active-run"),
            "update.status": {
              activeRun: createUpdateRunFixture({
                createdAtMs: now - 60_000,
                updatedAtMs: now - 2_000,
                target: { kind: "git", sha: "b".repeat(40) },
                steps: [{ step: "build", status: "in_progress" }],
              }),
              schedule: {
                channel: "dev",
                autoEnabled: true,
                install: { kind: "git" },
                target: {
                  kind: "git",
                  upstreamRef: "origin/main",
                  upstreamSha: "a".repeat(40),
                  commitsBehind: 3,
                },
                campaign: {
                  id: "queued-campaign",
                  state: "waiting-for-idle",
                  announcedAtMs: now,
                  forceAtMs: now + 15 * 60_000,
                  updatedAtMs: now,
                },
              },
            },
          },
          operatorScopes: ["operator.read", "operator.admin"],
        });
        expect((await page.goto(`${suite.server.baseUrl}settings/updates`))?.status()).toBe(200);
        await gateway.waitForRequest("update.status");
        const updating = page.getByRole("button", { name: "Updating…", exact: true });
        await updating.waitFor();
        await updating.scrollIntoViewIfNeeded();
        const status = page
          .locator(".settings-row")
          .filter({ has: page.locator(".settings-row__title", { hasText: /^Status$/ }) });
        expect(await status.textContent()).toContain("Updating · Staging");
        expect(await status.textContent()).not.toContain("Waiting for active work");
        expect(await page.getByText("bbbbbbbbbbbb", { exact: true }).count()).toBe(1);
        const automatic = page
          .locator(".settings-row")
          .filter({ has: page.locator(".settings-row__title", { hasText: /^Automatic update$/ }) });
        expect(await automatic.textContent()).toContain("Waiting for active work");
        expect(await automatic.textContent()).toContain("aaaaaaaa");
        expect(await updating.isDisabled()).toBe(true);
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
      },
    );
  });

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
      const policy = page.getByRole("switch", { name: "Automatic updates" });
      const checks = page.getByRole("switch", { name: "Check for updates" });
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
        const row = element.closest(".settings-row");
        const title = row?.querySelector(".settings-row__title");
        if (!row || !title) {
          throw new Error("Missing update status row or title");
        }
        const bounds = element.getBoundingClientRect();
        const rowBounds = row.getBoundingClientRect();
        const titleBounds = title.getBoundingClientRect();
        return {
          insideRow: bounds.left >= rowBounds.left && bounds.right <= rowBounds.right,
          overlapsTitle:
            bounds.left < titleBounds.right &&
            bounds.right > titleBounds.left &&
            bounds.top < titleBounds.bottom &&
            bounds.bottom > titleBounds.top,
          overflows: element.scrollWidth > element.clientWidth,
        };
      });
      expect(geometry).toEqual({ insideRow: true, overlapsTitle: false, overflows: false });
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
      const checks = content.getByRole("switch", { name: "Check for updates", exact: true });
      const automatic = content.getByRole("switch", { name: "Automatic updates", exact: true });
      await expect.poll(() => automatic.isChecked()).toBe(true);
      expect(await checks.isChecked()).toBe(false);
      expect(await automatic.isDisabled()).toBe(true);
      await content
        .locator(".settings-row__title")
        .filter({ hasText: /^Check for updates$/ })
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
      await content.getByText("Gateway version", { exact: true }).waitFor();
      await content.getByText("Control UI commit", { exact: true }).waitFor();

      const writesBeforeChannelChange = (await gateway.getRequests("config.set")).length;
      await content.getByRole("radio", { name: "Beta", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("config.set")).length)
        .toBe(writesBeforeChannelChange + 1);
      const configSet = (await gateway.getRequests("config.set")).at(-1);
      if (!configSet) {
        throw new Error("Missing channel config write");
      }
      const raw = (configSet.params as { raw?: unknown }).raw;
      expect(typeof raw).toBe("string");
      expect(JSON.parse(String(raw))).toMatchObject({ update: { channel: "beta" } });

      await content.getByRole("button", { name: "Update Gateway…", exact: true }).click();
      await page.getByRole("button", { name: "Update and restart", exact: true }).click();
      await gateway.waitForRequest("update.run");
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
      expect(await page.getByRole("switch", { name: "Check for updates" }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Update Gateway…" }).isDisabled()).toBe(true);
      expect(await gateway.getRequests("config.schema")).toHaveLength(0);
    });
  });

  it("keeps a failed manual status check visible", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const config = { update: { auto: { enabled: false }, channel: "stable" } };
      const gateway = await installMockGateway(page, {
        featureMethods: ["config.get", "update.run", "update.status"],
        methodResponses: {
          "config.get": configResponse(config, "updates-status-error-1"),
          "update.status": {
            sentinel: {
              kind: "update",
              status: "error",
              ts: Date.now(),
              stats: { mode: "package", reason: "build-failed" },
            },
          },
        },
        operatorScopes: ["operator.read", "operator.admin"],
      });

      expect((await page.goto(`${suite.server.baseUrl}settings/updates`))?.status()).toBe(200);
      await gateway.waitForRequest("update.status");
      const checkStatus = page.getByRole("button", { name: "Check status", exact: true });
      await checkStatus.waitFor();
      await expect.poll(() => checkStatus.isDisabled()).toBe(false);
      const discoveryRequests = () =>
        gateway.getRequests("update.status", { refreshCheckout: true });
      const statusRequestsBeforeCheck = (await discoveryRequests()).length;

      await gateway.deferNext("update.status");
      await checkStatus.click();
      await expect
        .poll(async () => (await discoveryRequests()).length)
        .toBe(statusRequestsBeforeCheck + 1);
      expect(await checkStatus.isDisabled()).toBe(true);

      await gateway.rejectDeferred("update.status", {
        code: "UNAVAILABLE",
        message: "Gateway status is temporarily unavailable",
      });
      await page
        .locator("#config-section-update .settings-status")
        .filter({ hasText: "Gateway status is temporarily unavailable" })
        .waitFor();
      expect(await checkStatus.isDisabled()).toBe(false);
    });
  });

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
        const report = page.getByRole("button", { name: "Report update failure", exact: true });
        await report.waitFor();
        await report.scrollIntoViewIfNeeded();
        expect(await report.isEnabled()).toBe(true);
        await report.click();
        await gateway.waitForRequest("update.report");
        const dialog = page.locator("openclaw-modal-dialog");
        await dialog.getByText(body, { exact: true }).waitFor();
        expect(await gateway.getRequests("update.report")).toHaveLength(1);
        await gateway.setMethodResponse("update.report", {
          status: "fallback",
          fallbackUrl,
          message:
            "Review and submit the prefilled issue using your own GitHub account in your browser. No issue has been submitted by the Gateway.",
        });
        await dialog.getByRole("button", { name: "Continue", exact: true }).click();
        await expect.poll(async () => (await gateway.getRequests("update.report")).length).toBe(2);
        expect((await gateway.getRequests("update.report"))[1]?.params).toEqual({
          action: "submit",
          attemptId: run.runId,
          previewDigest: "a".repeat(64),
        });
        const link = page.locator(`a[href="${fallbackUrl}"]`);
        await link.waitFor();
        expect(await link.getAttribute("target")).toBe("_blank");
        await link.scrollIntoViewIfNeeded();
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
      },
    );
  });
});
