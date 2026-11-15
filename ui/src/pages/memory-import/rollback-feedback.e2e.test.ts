import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({ name: "Memory rollback failure feedback" });

suite.define(() => {
  it("keeps rollback failures visible inside the confirmation and allows retry", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const method = "memory.sessionBackfill.rollback";
      const gateway = await installMockGateway(page, {
        deferredMethods: [method],
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "memory.sessionBackfill.preview",
          "memory.sessionBackfill.apply",
          method,
        ],
      });
      await page.goto(suite.server.baseUrl + "memory-import");
      await page.locator('[data-test-id="memory-backfill-rollback"]').click();
      const dialog = page.getByRole("dialog");
      const confirm = dialog.locator('[data-test-id="memory-backfill-rollback-confirm"]');
      await confirm.click();
      await expect.poll(async () => (await gateway.getRequests(method)).length).toBe(1);
      await gateway.rejectDeferred(method, {
        code: "UNAVAILABLE",
        message: "Rollback unavailable. Try again.",
      });
      await expect.poll(() => confirm.isEnabled()).toBe(true);
      const frame = await takeControlUiScreenshotFrame(page, dialog, [confirm], {
        animations: "disabled",
      });
      writeFileSync(path.join(suite.artifactDir, "rollback-failed.png"), frame.png);
      await expect
        .poll(() => dialog.getByRole("alert").textContent())
        .toContain("Rollback unavailable. Try again.");
      await expect
        .poll(async () => (await gateway.getRequests(method))[0]?.params)
        .toEqual({ agentId: "main" });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.poll(() => dialog.count()).toBe(0);
      await expect
        .poll(() => page.getByRole("alert").textContent())
        .toContain("Rollback unavailable. Try again.");
      await page.locator('[data-test-id="memory-backfill-rollback"]').click();
      await gateway.deferNext(method);
      await confirm.click();
      await expect.poll(async () => (await gateway.getRequests(method)).length).toBe(2);
      await expect.poll(() => dialog.getByRole("alert").count()).toBe(0);
      await expect.poll(() => confirm.isDisabled()).toBe(true);
      await gateway.resolveDeferred(method, { removedDiaryEntries: 3, removedStagedEntries: 2 });
      await expect.poll(() => dialog.count()).toBe(0);
      await expect
        .poll(() => page.locator('[data-test-id="memory-session-backfill"]').textContent())
        .toContain("3 diary");
    });
  });
});
