import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  cronJob,
  cronList,
  cronRuns,
  cronSidebarFeatureMethods,
} from "./cron-fixtures.test-support.ts";

const conversation = "agent:main:dashboard:garden-notes";
const suite = createControlUiE2eSuite({
  name: "Automation placement proof",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("shows the available run locations", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        const prompt = "Summarize this week’s garden notes for the volunteer handoff.";
        const gateway = await installMockGateway(page, {
          featureMethods: cronSidebarFeatureMethods,
          sessions: [
            { key: conversation, kind: "dashboard", displayName: "Community garden planning" },
          ],
          methodResponses: {
            "cron.add": cronJob("garden-shift", "Community garden handoff", {
              sessionTarget: `session:${conversation}`,
              payload: { kind: "agentTurn", message: prompt },
            }),
            "cron.list": cronList([], "garden-list"),
            "cron.runs": cronRuns([]),
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });
        await page.goto(suite.server.baseUrl + "cron?new");
        await page.locator("#cron-payload-text").fill(prompt);
        const target = page.locator(".cron-editor-placement");
        await page.locator("#cron-session-target").click();
        await page.getByRole("option", { name: "Continue a conversation", exact: true }).click();
        await page.locator("#cron-execution-conversation").click();
        const choice = page.getByRole("option", { name: "Community garden planning", exact: true });
        await page.getByRole("option", { name: "Main conversation", exact: true }).waitFor();
        if (process.env.OPENCLAW_CRON_PLACEMENT_PROOF) {
          const frame = await takeControlUiScreenshotFrame(page, target, [choice], {
            elements: [target],
            animations: "disabled",
          });
          await writeFile(".openclaw/tmp/cron-placement-after.png", frame.png);
        }
        await choice.click();
        await page.locator('[data-test-id="cron-submit"]').click();
        expect((await gateway.waitForRequest("cron.add")).params).toMatchObject({
          sessionTarget: `session:${conversation}`,
        });
      },
    );
  });
});
