import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronList, cronRuns } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Cron validation focus",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("focuses an invalid schedule field when its validation summary link is activated", async () => {
    const artifacts = createControlUiE2eArtifactDir("cron-validation-focus");
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "cron.list": cronList([], "validation-focus"),
          "cron.runs": cronRuns([]),
          "cron.status": { enabled: true, jobs: 0, triggersEnabled: true },
        },
      });
      await page.goto(suite.server.baseUrl + "cron?new");
      await page.locator("#cron-name").fill("Synthetic garden inventory");
      await page.locator("#cron-payload-text").fill("Summarize the fictional garden inventory.");
      await page.locator('[data-test-id="cron-schedule-hours"]').click();
      await page.locator('[data-test-id="cron-schedule-between"]').click();
      const input = page.locator("#cron-active-hours-start");
      await input.fill("invalid");
      await expect.poll(() => input.getAttribute("aria-invalid")).toBe("true");
      const link = page.locator(".cron-form-status__link").filter({ hasText: "From:" });
      await link.focus();
      await page.keyboard.press("Enter");
      const outcome = await input.evaluate((element) => ({
        focused: document.activeElement === element,
        visible: element.checkVisibility(),
        activeTag: document.activeElement?.tagName,
      }));
      writeFileSync(artifacts + "/outcome.json", JSON.stringify(outcome, null, 2));
      const target = outcome.visible ? input : link;
      const frame = await takeControlUiScreenshotFrame(page, target, [target], {
        animations: "disabled",
        scrollTo: target,
      });
      writeFileSync(artifacts + "/state.png", frame.png);
      expect(outcome).toMatchObject({ focused: true, visible: true });
      for (const method of ["cron.add", "cron.update", "cron.run"]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
    });
  });
});
