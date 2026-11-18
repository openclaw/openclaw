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
        const jobs = [
          cronJob("garden-shift", "Community garden handoff", {
            sessionTarget: "isolated",
            payload: {
              kind: "agentTurn",
              message: "Send a handoff with seedling counts and watering notes.",
            },
          }),
        ];
        const gateway = await installMockGateway(page, {
          featureMethods: cronSidebarFeatureMethods,
          methodResponses: {
            "agents.list": {
              agents: [{ id: "main", name: "Clawd" }],
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
            },
            "sessions.list": {
              ts: 1,
              path: "fixture",
              count: 1,
              defaults: {},
              sessions: [
                { key: conversation, kind: "dashboard", displayName: "Community garden planning" },
              ],
            },
            "cron.add": { ...jobs[0], sessionTarget: `session:${conversation}` },
            "cron.list": cronList(jobs, "garden-list"),
            "cron.runs": cronRuns([]),
            "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
          },
        });
        await page.goto(suite.server.baseUrl + "cron?new");
        await page.locator("#cron-name").fill("Weekly garden handoff");
        await page
          .locator("#cron-payload-text")
          .fill("Summarize this week’s garden notes for the volunteer handoff.");
        const target = page.locator(".cron-editor-placement");
        await page.locator("#cron-session-target").click();
        const option = page.getByRole("option", { name: "Continue a conversation", exact: true });
        expect(await option.isVisible()).toBe(true);
        await option.click();
        const conversationPicker = page.locator("#cron-execution-conversation");
        await conversationPicker.click();
        const choice = page.getByRole("option", { name: "Community garden planning", exact: true });
        await choice.waitFor();
        expect(
          await page.getByRole("option", { name: "Main conversation", exact: true }).isVisible(),
        ).toBe(true);
        const frame = await takeControlUiScreenshotFrame(page, target, [choice], {
          elements: [target],
          animations: "disabled",
        });
        if (process.env.OPENCLAW_CRON_PLACEMENT_PROOF) {
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
