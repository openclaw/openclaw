import { withTimeout } from "@openclaw/fs-safe/advanced";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { recordControlUiE2eFailureFacts } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  installMockGateway,
  type MockGatewayControls,
  waitForConfirmModal,
} from "../test-helpers/control-ui-e2e.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI coalesced update E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const NATIVE_UPDATE_DECLINED_EVENT = "openclaw:native-update-declined";
const updateCard = (page: Page) =>
  page.locator('openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]');
const updateDialog = (page: Page) => page.locator("openclaw-modal-dialog");
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const text = (root: Page | Locator, value: string) => root.getByText(value, { exact: true });
const failureText = "⚠️ OpenClaw update failed: global-install-failed.";
const restartingText = "⬆️ OpenClaw update in progress: restarting.";
const runResponses = (
  run: ReturnType<typeof createUpdateRunFixture> | null,
  response?: object,
) => ({
  "update.runs.get": { run },
  "update.status": { activeRun: null, lastRun: null },
  ...(response ? { "update.run": response } : {}),
});
function pageOptions(mobile = false): BrowserContextOptions {
  const viewport = mobile ? { height: 1200, width: 555 } : { height: 720, width: 1280 };
  return {
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(mobile ? { colorScheme: "dark", hasTouch: true, isMobile: true } : {}),
  };
}
function watchPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}
async function announceUpdate(page: Page, gateway: MockGatewayControls, mobile = false) {
  expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
  await gateway.waitForRequest("chat.startup");
  if (mobile) {
    await page.getByRole("button", { name: "Expand sidebar" }).click();
  }
  await gateway.emitGatewayEvent("update.available", {
    updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
  });
}
async function startUpdate(page: Page) {
  await openUpdateConfirmation(page);
  await updateDialog(page).getByRole("button", { name: "Update and restart", exact: true }).click();
}
async function openUpdateConfirmation(page: Page): Promise<void> {
  const updateIssue = await openUpdateIssue(page);
  await updateIssue.locator(".sidebar-update-card__action").click();
  await waitForConfirmModal(page);
}
async function openUpdateIssue(page: Page) {
  await page.locator(".sidebar-issues-button").click();
  const issue = updateCard(page);
  await issue.locator("summary").click();
  return issue;
}

suite.define(() => {
  it("explains a disabled update to a read-only mobile operator", async () => {
    await suite.withPage(pageOptions(true), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read"],
      });

      await announceUpdate(page, gateway, true);

      const updateIssue = await openUpdateIssue(page);
      const action = updateIssue.locator(".sidebar-update-card__action");
      await expect.poll(() => action.getAttribute("aria-disabled")).toBe("true");
      expect(await action.evaluate((element) => (element as HTMLButtonElement).disabled)).toBe(
        false,
      );

      const tooltipHost = updateIssue.locator("openclaw-tooltip");
      const tooltip = tooltipHost.locator(".tooltip-surface[popover]");
      await tooltipHost.evaluate((element) => {
        element.addEventListener(
          "overlay-after-show",
          () => element.setAttribute("data-e2e-after-show", ""),
          { once: true },
        );
      });
      await updateIssue.locator(".sidebar-update-card__actions").tap();
      await expect.poll(() => tooltipHost.getAttribute("data-e2e-after-show")).not.toBeNull();
      expect(await tooltip.textContent()).toContain("Administrator access is required");
      expect(await gateway.getRequests("update.run")).toHaveLength(0);
    });
  });

  it("shows package update failure status after the Update click", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
      const pageErrors = watchPageErrors(page);
      const run = createUpdateRunFixture({
        phase: "finished",
        status: "failed",
        reason: "global-install-failed",
        finishedAtMs: Date.now(),
        steps: [
          { step: "install", status: "failed", detail: "Package install did not verify on disk." },
        ],
      });
      const gateway = await installMockGateway(page, {
        methodResponses: runResponses(run, {
          ok: false,
          runId: run.runId,
          result: { reason: run.reason, status: "error" },
        }),
      });

      await announceUpdate(page, gateway);
      await startUpdate(page);
      const dialog = updateDialog(page);
      await text(dialog, failureText).first().waitFor();
      expect(await dialog.textContent()).toContain("openclaw triage");
      expect(await dialog.textContent()).toContain("Package install did not verify on disk.");
      expect(await gateway.getRequests("update.run")).toHaveLength(1);
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      await gateway.setMethodResponse("update.status", { activeRun: null, lastRun: run });
      await dialog.getByRole("button", { name: "Review update", exact: true }).click();
      await page.waitForURL("**/settings/updates");
      await page.locator("openclaw-config-page").waitFor();
      expect(await dialog.count()).toBe(0);
      expect(await page.locator("openclaw-sidebar-attention").count()).toBe(0);
      await text(page.locator("openclaw-update-run-view"), failureText).first().waitFor();
      expect(pageErrors).toEqual([]);
    });
  });

  it("shows coalesced restart feedback after the Update click", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
      const pageErrors = watchPageErrors(page);
      const run = createUpdateRunFixture({ phase: "restarting" });
      const gateway = await installMockGateway(page, {
        methodResponses: runResponses(run, {
          ok: true,
          runId: run.runId,
          restart: { coalesced: true },
          result: { after: { version: "2.0.0" }, status: "ok" },
        }),
      });

      await announceUpdate(page, gateway);
      await startUpdate(page);
      await button(page, "Updating…").waitFor();
      expect(await gateway.getRequests("update.run")).toHaveLength(1);
      await button(page, "Close").click();
      const updateIssue = await openUpdateIssue(page);
      await text(updateIssue, restartingText).first().waitFor();
      await updateIssue.locator(".sidebar-update-card__action").click();
      await text(updateDialog(page), restartingText).waitFor();
      expect(await gateway.getRequests("update.run")).toHaveLength(1);
      expect(await page.locator(".sidebar-issues-button__count").count()).toBe(1);
      expect(pageErrors).toEqual([]);
    });
  });

  it.each([
    ["response-first", true],
    ["disconnect-first", false],
  ] as const)("settles the managed update (%s)", async (artifactName, responseFirst) => {
    const expectedText = "Expected v2.0.0, running v1.0.0";
    await suite.withPage(pageOptions(), async ({ page }) => {
      const pageErrors = watchPageErrors(page);
      let run = createUpdateRunFixture({
        phase: "restarting",
        before: { version: "1.0.0" },
        target: { kind: "package", version: "2.0.0" },
      });
      const response = { ok: true, runId: run.runId, handoff: { status: "started" } };
      const gateway = await installMockGateway(page, {
        deferredMethods: ["update.run"],
        methodResponses: runResponses(run),
      });

      await announceUpdate(page, gateway);
      await startUpdate(page);
      await gateway.waitForRequest("update.run");
      if (responseFirst) {
        await gateway.resolveDeferred("update.run", response);
        await button(page, "Updating…").waitFor();
      }
      await gateway.setOnline(false);
      run = {
        ...run,
        phase: "finished",
        status: "failed",
        reason: "version-mismatch",
        updatedAtMs: run.updatedAtMs + 1,
        finishedAtMs: Date.now(),
        after: { version: "2.0.0" },
        verification: {
          booted: true,
          serviceRunning: true,
          runningVersion: "1.0.0",
          versionMatch: false,
        },
        steps: [{ step: "verifying", status: "failed", detail: expectedText }],
      };
      await gateway.setMethodResponse("update.runs.get", { run });
      await gateway.setMethodResponse("update.status", { activeRun: null, lastRun: run });
      await gateway.setGatewayBootId(`managed-handoff-${artifactName}`);
      await gateway.setOnline(true);

      try {
        const dialog = updateDialog(page);
        await text(dialog.locator(".update-run-view__details"), expectedText).waitFor();
        expect(await dialog.locator('[data-oracle="version"]').getAttribute("data-state")).toBe(
          "fail",
        );
        expect(await dialog.locator("[data-run-id]").getAttribute("data-run-id")).toBe(run.runId);
      } catch (error) {
        await captureControlUiE2eFailureDiagnostics(page, {
          error: error instanceof Error ? error : new Error(String(error)),
          label: `managed-handoff-${artifactName}`,
          pageErrors,
        });
        throw error;
      }
      expect(await gateway.getRequests("update.run")).toHaveLength(1);
      expect(pageErrors).toEqual([]);
    });
  });

  it.each(["available", "failed", "skipped"] as const)(
    "routes the %s sidebar update through live Mac app ownership",
    async (outcome) => {
      const context = await suite.browser.newContext(pageOptions());
      await context.addInitScript(() => {
        const messages: unknown[] = [];
        Object.assign(window, {
          openClawUpdateMessages: messages,
          webkit: {
            messageHandlers: {
              openclawUpdate: { postMessage: (message: unknown) => messages.push(message) },
            },
          },
        });
      });
      const page = await context.newPage();
      const pageErrors = watchPageErrors(page);
      const run =
        outcome === "available"
          ? null
          : createUpdateRunFixture({
              phase: "finished",
              status: outcome,
              reason: outcome === "skipped" ? "no-upstream" : "build-failed",
              finishedAtMs: Date.now(),
            });
      const gateway = await installMockGateway(page, {
        featureMethods: ["openclaw.chat", "update.run"],
        methodResponses: {
          ...runResponses(run, {
            ok: true,
            restart: null,
            result: { after: { version: "2.0.0" }, status: "ok" },
          }),
          "update.status": { activeRun: null, lastRun: run },
        },
      });

      try {
        await announceUpdate(page, gateway);

        await openUpdateConfirmation(page);
        if (run) {
          await button(page, "Retry update").click();
        }
        expect(await page.locator("openclaw-modal-dialog").getAttribute("label")).toBe(
          "Update Mac app + Gateway",
        );
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await button(page, "Update Mac app and restart").click();
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { openClawUpdateMessages: unknown[] }).openClawUpdateMessages,
          ),
        ).toEqual([{ type: "start-update" }]);
        expect(await gateway.getRequests("update.run")).toHaveLength(0);

        await page.keyboard.press("Control+Shift+,");
        await page.locator(".shell--settings").waitFor();
        expect(await page.locator("openclaw-sidebar-attention").count()).toBe(0);
        await page.evaluate(
          (eventName) => window.dispatchEvent(new CustomEvent(eventName)),
          NATIVE_UPDATE_DECLINED_EVENT,
        );
        await expect.poll(async () => (await gateway.getRequests("update.run")).length).toBe(1);
        expect(pageErrors).toEqual([]);
      } catch (error) {
        await withTimeout(
          page.evaluate(() => {
            const modal = document.querySelector("openclaw-modal-dialog");
            const buttons = [...(modal?.querySelectorAll("button") ?? [])];
            const confirm = buttons.find(
              (element) => element.textContent?.trim() === "Update Mac app and restart",
            );
            const retry = buttons.find((element) => element.textContent?.trim() === "Retry update");
            return {
              nativeUpdateDialogPresent: Boolean(modal),
              nativeUpdateDialogOpen: modal?.querySelector("dialog")?.open ?? false,
              nativeUpdateConfirmPresent: Boolean(confirm),
              nativeUpdateConfirmDisabled: confirm?.disabled ?? null,
              nativeUpdateRetryPresent: Boolean(retry),
              nativeUpdateRetryDisabled: retry?.disabled ?? null,
            };
          }),
          1_000,
        )
          .then((facts) => recordControlUiE2eFailureFacts(page, facts))
          .catch(() => undefined);
        await captureControlUiE2eFailureDiagnostics(page, {
          error: error instanceof Error ? error : new Error(String(error)),
          label: `native-update-${outcome}`,
          pageErrors,
        });
        throw error;
      } finally {
        await context.close();
      }
    },
  );
});
