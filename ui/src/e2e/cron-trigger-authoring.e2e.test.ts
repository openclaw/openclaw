// Real-Chromium coverage keeps automation condition authoring aligned with Gateway contracts.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation condition-trigger authoring",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const proofDirectoryParent = process.env.OPENCLAW_TRIGGER_UI_PROOF_DIR;
let proofDirectory: string | undefined;
beforeEach(() => {
  proofDirectory = proofDirectoryParent
    ? createControlUiE2eArtifactDir("cron-trigger-authoring", proofDirectoryParent)
    : undefined;
});
const proofStage = process.env.OPENCLAW_TRIGGER_UI_PROOF_STAGE ?? "after";

const scriptJob: CronJob = {
  id: "existing-script-automation",
  configRevision: "existing-script-revision",
  name: "Script health check",
  enabled: true,
  createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
  updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "script", script: "return { ready: true };" },
  state: {},
};

const pageOptions = {
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 1_050, width: 1_440 },
};
const triggerToggle = (page: Page) =>
  page.locator(".settings-row--toggle").filter({ hasText: "Condition trigger" });
const field = (page: Page, name: string) => page.locator(`#cron-${name}`);
const submit = (page: Page) => page.locator('[data-test-id="cron-submit"]');
async function newTask(page: Page, name: string, message: string) {
  await page.locator('[data-test-id="cron-new-task"]').click();
  await field(page, "name").fill(name);
  await field(page, "payload-text").fill(message);
}
const advanced = (page: Page) => page.locator("details.cron-advanced > summary").click();

function listResponse(jobs: CronJob[]) {
  return {
    jobs,
    snapshotRevision: "trigger-authoring-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function cronMethodResponses(jobs: CronJob[]) {
  return {
    "cron.add": { id: "new-automation" },
    "cron.list": cronListResponseFixture([
      { match: { lastRunStatus: "error" }, response: listResponse([]) },
      { response: listResponse(jobs) },
    ]),
    "cron.runs": {
      entries: [],
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    },
    "cron.status": { enabled: true, triggersEnabled: true, jobs: jobs.length, nextWakeAtMs: null },
  };
}

async function captureProof(page: Page, name: string) {
  if (!proofDirectory) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    path: path.join(proofDirectory, `${proofStage}-${name}.png`),
  });
}

async function captureTriggerCapabilityProof(page: Page, name: string) {
  await page
    .locator(".settings-row__title")
    .filter({ hasText: "Condition trigger" })
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await captureProof(page, name);
}

async function selectSeconds(page: Page) {
  const unit = page.getByRole("button", { name: /^Unit: /u });
  await unit.click();
  await page.getByRole("option", { name: "Seconds", exact: true }).click();
}

suite.define(() => {
  it("prevents unsupported condition triggers while preserving valid interval submissions", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: cronMethodResponses([scriptJob]),
      });

      await page.goto(`${suite.server.baseUrl}cron`);
      await page.locator('[data-test-id="cron-row-existing-script-automation"]').click();
      await advanced(page);

      const scriptTriggerControlCount = await page
        .getByRole("switch", { name: "Condition trigger", exact: true })
        .count();
      await page
        .getByText("Condition trigger", { exact: true })
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await captureProof(page, "01-script-payload-condition-control");

      await page.locator('[data-test-id="cron-back"]').click();
      await newTask(page, "Conditional interval", "Run when the condition matches");
      await selectSeconds(page);
      await field(page, "every-amount").fill("5");
      await advanced(page);
      await triggerToggle(page).click();
      await field(page, "trigger-script").fill("json({ fire: true })");
      await page
        .locator("#cron-every-amount")
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await captureProof(page, "02-triggered-five-second-validation");

      expect(scriptTriggerControlCount).toBe(0);

      const intervalError = field(page, "error-everyAmount");
      await intervalError.waitFor({ state: "visible" });
      expect(await intervalError.textContent()).toMatch(/30/);
      expect(await field(page, "every-amount").getAttribute("aria-invalid")).toBe("true");
      expect(await submit(page).isDisabled()).toBe(true);
      expect(await gateway.getRequests("cron.add")).toHaveLength(0);

      await field(page, "every-amount").fill("30");
      await expect.poll(async () => intervalError.count()).toBe(0);
      expect(await submit(page).isEnabled()).toBe(true);
      await captureProof(page, "03-triggered-thirty-second-boundary");
      await submit(page).click();

      const triggeredRequest = await gateway.waitForRequest("cron.add");
      expect(triggeredRequest.params).toMatchObject({
        name: "Conditional interval",
        schedule: { kind: "every", everyMs: 30_000 },
        trigger: { script: "json({ fire: true })", once: false },
      });
      await expect.poll(async () => submit(page).count()).toBe(0);

      await newTask(page, "Unconditional interval", "Run every five seconds");
      await selectSeconds(page);
      await field(page, "every-amount").fill("5");

      expect(await field(page, "error-everyAmount").count()).toBe(0);
      expect(await submit(page).isEnabled()).toBe(true);
      await captureProof(page, "04-untriggered-five-second-interval");

      const previousAdds = (await gateway.getRequests("cron.add")).length;
      await submit(page).click();
      const untriggeredRequest = await gateway.waitForRequest("cron.add", {
        after: previousAdds,
      });
      expect(untriggeredRequest.params).toMatchObject({
        name: "Unconditional interval",
        schedule: { kind: "every", everyMs: 5_000 },
      });
      expect(untriggeredRequest.params).not.toHaveProperty("trigger");
    });
  });

  it("keeps saved and unsaved trigger drafts separate from reconnect-refreshed scheduler capability", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const initialConfig = { cron: { triggers: { enabled: true } } };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": {
            appliedConfigHash: "trigger-config-1",
            config: initialConfig,
            configRevisionHash: "trigger-config-1",
            hash: "trigger-config-1",
            issues: [],
            raw: JSON.stringify(initialConfig),
            valid: true,
          },
          "cron.list": listResponse([]),
          "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
          "cron.status": { enabled: true, triggersEnabled: true, jobs: 0, nextWakeAtMs: null },
        },
      });

      await page.goto(`${suite.server.baseUrl}cron`);
      await page.locator('[data-test-id="cron-new-task"]').click();
      await advanced(page);
      const toggle = triggerToggle(page);
      await expect.poll(() => toggle.count()).toBe(1);

      const unsaved = await evaluateControlUiContext(page, async (context) => {
        const config = context.runtimeConfig;
        await config.ensureLoaded();
        config.setWritesSuspended(true);
        config.patchForm(["cron", "triggers", "enabled"], false);
        return { dirty: config.state.configFormDirty, needsApply: config.state.configNeedsApply };
      });
      expect(unsaved).toEqual({ dirty: true, needsApply: false });
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      await expect.poll(() => toggle.count()).toBe(1);
      await captureTriggerCapabilityProof(page, "05-unsaved-disable-keeps-active-trigger");

      await evaluateControlUiContext(page, (context) => {
        const config = context.runtimeConfig;
        config.setWritesSuspended(false);
        // Observe this long-lived save through Gateway/state boundaries; returning its
        // promise through CDP lets Chromium collect it under full-shard memory pressure.
        void config.save();
      });
      const savedRequest = await gateway.waitForRequest("config.set");
      expect(JSON.parse(String((savedRequest.params as { raw?: string }).raw))).toEqual({
        cron: { triggers: { enabled: false } },
      });
      await expect
        .poll(() =>
          evaluateControlUiContext(page, (context) => {
            const config = context.runtimeConfig;
            return {
              dirty: config.state.configFormDirty,
              needsApply: config.state.configNeedsApply,
              saving: config.state.configSaving,
            };
          }),
        )
        .toEqual({ dirty: false, needsApply: true, saving: false });
      expect(await gateway.getRequests("config.apply")).toHaveLength(0);
      await expect.poll(() => toggle.count()).toBe(1);
      await captureTriggerCapabilityProof(page, "06-saved-unapplied-keeps-active-trigger");

      const previousStatuses = (await gateway.getRequests("cron.status")).length;
      await gateway.setMethodResponse("cron.status", {
        enabled: true,
        triggersEnabled: false,
        jobs: 0,
        nextWakeAtMs: null,
      });
      await gateway.closeLatest(1012, "refresh effective trigger capability");
      await expect
        .poll(async () => (await gateway.getRequests("cron.status")).length)
        .toBeGreaterThan(previousStatuses);
      await page.locator('[data-test-id="cron-new-task"]').click();
      await advanced(page);
      await expect.poll(() => toggle.count()).toBe(0);
      await page.getByText("Condition triggers are disabled by cron.triggers.enabled.").waitFor();
      await captureTriggerCapabilityProof(page, "07-reconnect-refreshes-disabled-trigger");

      const oppositeDraft = await evaluateControlUiContext(page, async (context) => {
        const config = context.runtimeConfig;
        await config.ensureLoaded();
        config.setWritesSuspended(true);
        config.patchForm(["cron", "triggers", "enabled"], true);
        return config.state.configFormDirty;
      });
      expect(oppositeDraft).toBe(true);
      await expect.poll(() => toggle.count()).toBe(0);
      await captureTriggerCapabilityProof(page, "08-unsaved-enable-cannot-author-disabled-trigger");
      await evaluateControlUiContext(page, async (context) => {
        const config = context.runtimeConfig;
        await config.discardDraft();
        config.setWritesSuspended(false);
      });
    });
  });

  it("keeps a rejected trigger draft visible without reloading inventory", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: cronMethodResponses([scriptJob]),
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      const existingRow = page.locator('[data-test-id="cron-row-existing-script-automation"]');
      await existingRow.waitFor();
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
        trigger: { script: "const x = ;", once: false },
      });
      const message = "Condition script is invalid";
      await gateway.rejectDeferred("cron.add", { code: "INVALID_REQUEST", message });

      const errorBanner = page.locator(".cron-error-banner");
      await errorBanner.waitFor({ state: "visible" });
      expect(await errorBanner.textContent()).toContain(message);
      expect(await triggerScript.inputValue()).toBe("const x = ;");
      expect(await gateway.getRequests("cron.list")).toHaveLength(listsBeforeSave);
      await errorBanner.scrollIntoViewIfNeeded();
      await captureProof(page, "05-malformed-trigger-rejected");

      // A rejected save must release the fieldset's inherited disabled state.
      const once = page.locator('[data-test-id="cron-schedule-kind-at"]').getByRole("radio");
      await once.scrollIntoViewIfNeeded();
      await captureProof(page, "06-repeat-after-rejection");
      await expect.poll(() => once.isEnabled()).toBe(true);
      await once.click();
      await field(page, "schedule-at").waitFor();
      expect(await field(page, "name").inputValue()).toBe("Malformed condition");
      expect(await gateway.getRequests("cron.add")).toHaveLength(1);

      await page.locator('[data-test-id="cron-back"]').click();
      await existingRow.waitFor();
      expect(await gateway.getRequests("cron.list")).toHaveLength(listsBeforeSave);
    });
  });
});
