import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList, cronRuns } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Automation prompt preview",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("keeps a long prompt readable without displacing the remaining settings", async () => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        viewport: { width: 1200, height: 1096 },
        locale: "en-US",
      },
      async ({ page }) => {
        const prompt =
          "# Fictional garden report\n\n" +
          Array.from(
            { length: 40 },
            (_, index) =>
              "## Plot " +
              (index + 1) +
              "\nSummarize the fictional herbs, flowers, and seedlings. Compare planned watering with the sample schedule and list observations for the next garden report.\n\n",
          ).join("") +
          "End of fictional garden instructions.";
        const job = cronJob("garden-preview", "Fictional garden report", {
          configRevision: "garden-preview-revision",
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: prompt },
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronList([job], "garden-preview"),
            "cron.runs": cronRuns([]),
            "cron.status": { enabled: true, jobs: 1 },
            "cron.update": {
              ...job,
              payload: { kind: "agentTurn", message: prompt + "\nEdited." },
            },
          },
        });
        await page.goto(suite.server.baseUrl + "cron");
        await page.locator('[data-test-id="cron-row-garden-preview"] .cron-table__name').click();
        const input = page.locator("#cron-payload-text");
        await input.waitFor({ state: "visible" });
        expect(await input.inputValue()).toBe(prompt);
        const preview = page.locator(".cron-editor .chat-text");
        await preview.waitFor({ state: "visible" });
        const frame = await takeControlUiScreenshotFrame(page, input, [input, preview], {
          animations: "disabled",
          scrollTo: input,
        });
        writeFileSync(suite.artifactDir + "/prompt-preview.png", frame.png);
        const height = await preview.evaluate(
          (element) =>
            (element.closest(".cron-prompt-preview") ?? element).getBoundingClientRect().height,
        );
        expect(height).toBeLessThanOrEqual(240);
        const region = page.getByRole("region", { name: "Prompt preview", exact: true });
        await region.focus();
        await page.keyboard.press("End");
        expect(await region.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
          "solid",
        );
        await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(await preview.textContent()).toContain("End of fictional garden instructions.");
        await input.fill(prompt + "\nEdited.");
        await expect.poll(() => preview.textContent()).toContain("Edited.");
        await page.locator('[data-test-id="cron-submit"]').click();
        await gateway.waitForRequest("cron.update");
        expect((await gateway.getRequests("cron.update")).at(-1)?.params).toMatchObject({
          id: job.id,
          patch: { payload: { kind: "agentTurn", message: prompt + "\nEdited." } },
        });
      },
    );
  });
});
