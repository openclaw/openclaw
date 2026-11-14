import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { createUpdateRunFixture } from "./update-run.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Update request state" });
const waiting = "Waiting for the Gateway to confirm update progress…";

suite.define(() => {
  it.each(["settings", "inbox"] as const)(
    "does not claim installation before the %s update is acknowledged",
    async (entry) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const config = { update: { auto: { enabled: false }, channel: "stable" } };
          const available = {
            channel: "stable",
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
          } as const;
          const gateway = await installMockGateway(page, {
            updateAvailable: available,
            featureMethods: ["config.get", "config.set", "update.run", "update.status"],
            methodResponses: {
              "config.get": {
                config,
                hash: "synthetic-update",
                issues: [],
                raw: JSON.stringify(config),
                runtimeConfig: config,
                valid: true,
              },
              "update.status": { updateAvailable: available },
            },
          });
          await page.goto(
            suite.server.baseUrl + (entry === "settings" ? "settings/updates" : "chat"),
          );
          if (entry === "settings") {
            await gateway.waitForRequest("config.get");
            await page.getByRole("button", { name: "Update Gateway…", exact: true }).click();
          } else {
            await gateway.waitForRequest("sessions.messages.subscribe");
            await page.locator(".sidebar-issues-button:visible").click();
            const card = page.locator(
              'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
            );
            await card.locator("summary").click();
            await card.locator(".sidebar-update-card__action").click();
          }
          const modal = page.locator("openclaw-modal-dialog");
          const confirm = modal.getByRole("button", { name: "Update and restart", exact: true });
          await confirm.waitFor();
          expect(await gateway.getRequests("update.run")).toHaveLength(0);
          await gateway.deferNext("update.run");
          await confirm.click();
          await gateway.waitForRequest("update.run");
          const busy = modal.getByRole("button", { name: "Updating…", exact: true });
          await expect.poll(() => busy.isDisabled()).toBe(true);
          const frame = await takeControlUiScreenshotFrame(
            page,
            modal.locator(".oc-dialog"),
            [busy, modal.locator(".oc-dialog__header")],
            { animations: "disabled", elements: [modal.locator(".oc-dialog")] },
          );
          await writeFile(path.join(suite.artifactDir, entry + "-pending.png"), frame.png);
          await writeFile(
            path.join(suite.artifactDir, entry + "-pending-dialog.png"),
            frame.elements[0]!.png,
          );
          expect.soft(await modal.textContent()).toContain(waiting);
          expect.soft(await modal.textContent()).not.toContain("Installing the update");
          expect(await gateway.getRequests("update.run")).toHaveLength(1);
          if (entry === "settings") {
            await gateway.deferNext("update.runs.get");
            const run = createUpdateRunFixture();
            await gateway.resolveDeferred("update.run", { ok: true, runId: run.runId });
            await gateway.waitForRequest("update.runs.get");
            expect.soft(await modal.textContent()).toContain(waiting);
            await gateway.resolveDeferred("update.runs.get", { run });
            const report = modal.locator("openclaw-update-run-view");
            await report.waitFor();
            expect(await report.textContent()).toContain("Downloading the update package.");
            expect(await modal.textContent()).not.toContain(waiting);
          } else {
            await gateway.rejectDeferred("update.run", {
              code: "UNAVAILABLE",
              message: "Synthetic update admission refused.",
            });
            await modal
              .getByText("Couldn’t update OpenClaw. Synthetic update admission refused.", {
                exact: true,
              })
              .waitFor();
            expect(await modal.textContent()).not.toContain(waiting);
            expect(await gateway.getRequests("update.runs.get")).toHaveLength(0);
          }
          expect(await gateway.getRequests("update.run")).toHaveLength(1);
          await modal
            .locator("openclaw-modal-actions")
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await modal.waitFor({ state: "detached" });
        },
      );
    },
  );
});
