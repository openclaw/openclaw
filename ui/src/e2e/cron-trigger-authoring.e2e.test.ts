import { writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  automationRow,
  cronJob,
  cronList,
  cronRuns,
  cronSidebarFeatureMethods,
  openAutomationActivity,
  chooseScheduleKind,
} from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation condition-trigger authoring",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const scriptJob = cronJob("existing-script-automation", "Script health check", {
  sessionTarget: "isolated",
  payload: { kind: "none" },
  check: { script: "return { post: 'Workspace degraded' };" },
});

const pageOptions = {
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 1_050, width: 1_440 },
};
const triggerToggle = (page: Page) =>
  page.locator(".settings-row--toggle").filter({ hasText: "Run a model-free check" });
const field = (page: Page, name: string) => page.locator(`#cron-${name}`);
const submit = (page: Page) => page.locator('[data-test-id="cron-submit"]');
async function newTask(page: Page, name: string, message: string) {
  await page.locator('[data-test-id="cron-new-task"]').click();
  await field(page, "name").fill(name);
  await field(page, "payload-text").fill(message);
}
const advanced = (page: Page) => page.locator("details.cron-advanced > summary").click();

const listResponse = (jobs: CronJob[]) => cronList(jobs, "trigger-authoring-fixture");

function cronMethodResponses(jobs: CronJob[]) {
  return {
    "cron.add": { id: "new-automation" },
    "cron.list": cronListResponseFixture([
      { match: { lastRunStatus: "error" }, response: listResponse([]) },
      { response: listResponse(jobs) },
    ]),
    "cron.runs": cronRuns([]),
    "cron.status": { enabled: true, triggersEnabled: true, jobs: jobs.length, nextWakeAtMs: null },
  };
}

async function selectSeconds(page: Page) {
  await page.getByRole("button", { name: /^Unit: /u }).click();
  await page.getByRole("option", { name: "Seconds", exact: true }).click();
}

suite.define(() => {
  it("capture the workspace health check editor", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await installMockGateway(page, { methodResponses: cronMethodResponses([scriptJob]) });
      await page.goto(`${suite.server.baseUrl}cron`);
      await newTask(
        page,
        "Workspace health check",
        "Summarize the issue and suggest what to do next.",
      );
      await advanced(page);
      await triggerToggle(page).click();
      const code = field(page, "trigger-script");
      await code.fill(
        'if (check.state?.status === "degraded") return {};\nreturn { wake: "Workspace is degraded", state: { status: "degraded" } };',
      );
      await code.waitFor({ state: "visible" });
      if (process.env.OPENCLAW_CHECK_PROOF !== "1") return;
      const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [code], {
        elements: [code],
        animations: "disabled",
        scrollTo: code,
      });
      await writeFile(".check-after.png", frame.png);
    });
  });
  it("submits triggered and ordinary intervals at their respective boundaries", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: cronMethodResponses([scriptJob]),
      });

      await page.goto(`${suite.server.baseUrl}cron`);
      await newTask(page, "Conditional interval", "Run when the condition matches");
      await selectSeconds(page);
      await field(page, "every-amount").fill("5");
      await advanced(page);
      await triggerToggle(page).click();
      await field(page, "trigger-script").fill("return { wake: 'ready' };");

      const intervalError = field(page, "error-everyAmount");
      await intervalError.waitFor({ state: "visible" });
      expect(await intervalError.textContent()).toMatch(/30/);
      expect(await field(page, "every-amount").getAttribute("aria-invalid")).toBe("true");
      expect(await submit(page).isDisabled()).toBe(true);
      expect(await gateway.getRequests("cron.add")).toHaveLength(0);

      await field(page, "every-amount").fill("30");
      await expect.poll(async () => intervalError.count()).toBe(0);
      expect(await submit(page).isEnabled()).toBe(true);
      await submit(page).click();

      const triggeredRequest = await gateway.waitForRequest("cron.add");
      expect(triggeredRequest.params).toMatchObject({
        name: "Conditional interval",
        schedule: { kind: "every", everyMs: 30_000 },
        check: { script: "return { wake: 'ready' };", once: false },
      });
      await expect.poll(async () => submit(page).count()).toBe(0);

      await newTask(page, "Unconditional interval", "Run every five seconds");
      await selectSeconds(page);
      await field(page, "every-amount").fill("5");

      expect(await field(page, "error-everyAmount").count()).toBe(0);
      expect(await submit(page).isEnabled()).toBe(true);

      const previousAdds = (await gateway.getRequests("cron.add")).length;
      await submit(page).click();
      const untriggeredRequest = await gateway.waitForRequest("cron.add", {
        after: previousAdds,
      });
      expect(untriggeredRequest.params).toMatchObject({
        name: "Unconditional interval",
        schedule: { kind: "every", everyMs: 5_000 },
      });
      expect(untriggeredRequest.params).not.toHaveProperty("check");
    });
  });

  it("keeps a rejected trigger draft visible without reloading inventory", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: cronSidebarFeatureMethods,
        methodResponses: cronMethodResponses([scriptJob]),
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      const existingRow = await automationRow(page, scriptJob.id);
      await newTask(page, "Malformed condition", "Run when the condition matches");
      await advanced(page);
      await triggerToggle(page).click();
      const triggerScript = field(page, "trigger-script");
      await triggerScript.fill("const x = ;");
      const listsBeforeSave = (await gateway.getRequests("cron.list")).length;
      const save = submit(page);

      await gateway.deferNext("cron.add");
      await save.click();
      const request = await gateway.waitForRequest("cron.add");
      expect(request.params).toMatchObject({
        name: "Malformed condition",
        check: { script: "const x = ;", once: false },
      });
      const message = "Check script is invalid";
      await gateway.rejectDeferred("cron.add", { code: "INVALID_REQUEST", message });

      const errorBanner = page.locator(".callout.danger");
      await errorBanner.waitFor({ state: "visible" });
      expect(await errorBanner.textContent()).toContain(message);
      expect(await triggerScript.inputValue()).toBe("const x = ;");
      expect(await gateway.getRequests("cron.list")).toHaveLength(listsBeforeSave);
      await errorBanner.scrollIntoViewIfNeeded();

      // A rejected save must release the fieldset's inherited disabled state.
      await expect
        .poll(() =>
          page
            .locator("fieldset.cron-editor")
            .evaluate((element) => (element as HTMLFieldSetElement).disabled),
        )
        .toBe(false);
      await chooseScheduleKind(page, "at");
      await field(page, "schedule-at").waitFor();
      expect(await field(page, "name").inputValue()).toBe("Malformed condition");
      expect(await gateway.getRequests("cron.add")).toHaveLength(1);

      // Leaving the rejected draft keeps the sidebar's inventory without reading it again.
      await openAutomationActivity(page);
      await existingRow.waitFor();
      expect(await gateway.getRequests("cron.list")).toHaveLength(listsBeforeSave);
    });
  });
});
