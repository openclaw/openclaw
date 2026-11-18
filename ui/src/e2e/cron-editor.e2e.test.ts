import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  cronJob,
  cronList,
  cronRuns,
  cronSidebarFeatureMethods,
} from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Automation editor" });
suite.define(() => {
  it("creates a one-time automation using the Gateway's start and cleanup defaults", async () => {
    const name = "Friday release checklist";
    const prompt = "Review the release checklist and summarize anything still open.";
    await suite.withPage({ locale: "en-US", timezoneId: "UTC" }, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-11-18T14:00:00Z"));
      const gateway = await installMockGateway(page, {
        featureMethods: cronSidebarFeatureMethods,
        methodResponses: {
          "cron.list": cronList([], "editor"),
          "cron.runs": cronRuns([]),
          "cron.status": { enabled: true, triggersEnabled: true, jobs: 0 },
          "cron.add": cronJob("review", name),
        },
      });
      await page.goto(suite.server.baseUrl + "automations?new");
      await page.locator("#cron-name").fill(name);
      await page.locator("#cron-payload-text").fill(prompt);
      await page.locator('[data-test-id="cron-schedule-frequency"]').click();
      await page.locator('[data-test-id="cron-schedule-frequency-once"]').click();
      await page.locator("#cron-schedule-at").fill("2026-11-20T16:30");
      await page.getByText("Advanced", { exact: true }).click();
      for (const label of [
        "Turn on after creating",
        "Delete after it runs",
        "Prompt preview",
        "Session key",
      ]) {
        expect(await page.getByText(label, { exact: true }).count()).toBe(0);
      }
      await page.locator('[data-test-id="cron-submit"]').click();
      const { params } = await gateway.waitForRequest("cron.add");
      expect(params).toMatchObject({
        name,
        schedule: { kind: "at", at: "2026-11-20T16:30:00.000Z" },
        payload: { kind: "agentTurn", message: prompt },
      });
      expect(params).not.toHaveProperty("enabled");
      expect(params).not.toHaveProperty("deleteAfterRun");
      expect(params).not.toHaveProperty("sessionKey");
    });
  });
});
