import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { pickerValue as readPickerValue } from "../test-helpers/select-picker-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  cronJob,
  cronList,
  cronRuns,
  cronSidebarFeatureMethods,
  editAutomation,
  openAutomationActivity,
} from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron select values mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

const gardenMessage = "Summarize the fictional garden inventory.";
function gardenJob(overrides: Partial<CronJob> = {}): CronJob {
  return cronJob("garden-keyboard", "Garden keyboard task", {
    configRevision: "garden-revision",
    schedule: { kind: "every", everyMs: 1_800_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: gardenMessage },
    ...overrides,
  });
}

function cronResponses(jobs: CronJob[], snapshotRevision: string, enabled = true, compact = true) {
  const list = cronList(jobs, snapshotRevision);
  return {
    "cron.list": compact ? cronListResponseFixture(list) : list,
    "cron.get": { cases: jobs.map((job) => ({ match: { id: job.id }, response: job })) },
    "cron.runs": cronRuns([]),
    "cron.status": { enabled, jobs: jobs.length, nextWakeAtMs: null },
  };
}

suite.define(() => {
  it("requires an explicit delivery choice before saving an unrepaired job", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        const job = gardenJob({
          id: "garden-legacy-delivery",
          name: "Garden summary",
          configRevision: "garden-legacy-revision",
          delivery: { mode: "announce", channel: "telegram", to: "garden-room" },
        });
        Reflect.deleteProperty(job.delivery!, "mode");
        const gateway = await installMockGateway(page, {
          featureMethods: cronSidebarFeatureMethods,
          methodResponses: {
            ...cronResponses([job], "garden-legacy-list"),
            "cron.update": {
              ...job,
              name: "Renamed garden summary",
              configRevision: "garden-corrected-revision",
              delivery: { mode: "none" },
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await editAutomation(page, job.id);
        await page.locator("#cron-name").fill("Renamed garden summary");
        await page.locator(".cron-form-status__link").filter({ hasText: "Mode:" }).click();
        const mode = page.locator("#cron-delivery-mode");
        expect(await mode.evaluate((element) => document.activeElement === element)).toBe(true);
        await page.evaluate(() => document.fonts.ready);
        expect(
          await readPickerValue(page.locator("openclaw-select-picker:has(#cron-delivery-mode)")),
        ).toBe("");
        expect(await mode.getAttribute("aria-invalid")).toBe("true");
        expect(await page.locator("#cron-error-deliveryMode").textContent()).toContain(
          "openclaw doctor --fix",
        );
        expect(await page.locator('[data-test-id="cron-submit"]').isDisabled()).toBe(true);
        expect(await gateway.getRequests("cron.update")).toHaveLength(0);

        await mode.click();
        await page.getByRole("option", { name: "None (internal)", exact: true }).click();
        await expect
          .poll(() => page.locator('[data-test-id="cron-submit"]').isDisabled())
          .toBe(false);
        await page.locator('[data-test-id="cron-submit"]').click();
        const request = await gateway.waitForRequest("cron.update");
        expect(request.params).toMatchObject({
          id: job.id,
          expectedConfigRevision: "garden-legacy-revision",
          patch: { name: "Renamed garden summary", delivery: { mode: "none" } },
        });
        expect(await gateway.getRequests("cron.update")).toHaveLength(1);
      },
    );
  });

  it("shows the authoritative defaults in the create-form selects", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: cronSidebarFeatureMethods,
        methodResponses: cronResponses([gardenJob()], "cron-select-values-fixture", true, false),
      });

      const response = await page.goto(`${suite.server.baseUrl}cron`);
      expect(response?.status()).toBe(200);
      await openAutomationActivity(page);
      const sortMenu = page.locator(".cron-filter-dropdown__details", {
        has: page.locator(".cron-run-sort"),
      });
      const sort = page.getByRole("button", { name: "Sort Newest first", exact: true });
      await sort.waitFor({ state: "visible" });
      await sort.click();
      await sortMenu.locator('[data-value="asc"]').click();
      await page.getByRole("button", { name: "Sort Oldest first", exact: true }).waitFor();
      // Leaving Activity and returning recreates the dropdown with the persisted non-first value.
      const newAutomation = page.locator(".sidebar-automations__new");
      await newAutomation.click();
      await page.locator("#cron-name").waitFor({ state: "visible" });
      await openAutomationActivity(page);
      await page.getByRole("button", { name: "Sort Oldest first", exact: true }).waitFor();
      expect(await sortMenu.locator('[data-value="asc"]').getAttribute("aria-current")).toBe(
        "true",
      );
      await newAutomation.click();

      const pickerValue = (selector: string) =>
        readPickerValue(page.locator(`openclaw-select-picker:has(${selector})`));
      // Action leads the task settings under Advanced.
      await page.locator("details.cron-advanced > summary").click();
      const action = page.locator("#cron-payload-kind");
      await action.waitFor({ state: "visible" });
      // Form defaults are agentTurn / isolated / minutes — none of which is
      // the first option of its select; the rendered selection must agree.
      expect(await pickerValue("#cron-payload-kind")).toBe("agentTurn");
      expect(await pickerValue("#cron-session-target")).toBe("isolated");
      const unit = page.locator("openclaw-select-picker").filter({
        has: page.getByRole("button", { name: /^Unit: /u }),
      });
      expect(await readPickerValue(unit)).toBe("minutes");
      expect(await pickerValue("#cron-delivery-mode")).toBe("none");
      expect(await page.locator("#cron-delivery-channel").count()).toBe(0);

      await action.click();
      await page.getByRole("option", { name: "Post to main session", exact: true }).click();
      await expect.poll(() => pickerValue("#cron-payload-kind")).toBe("systemEvent");
      await expect.poll(() => pickerValue("#cron-session-target")).toBe("main");
      await expect
        .poll(() =>
          page
            .getByText(
              "Main adds the task to the agent’s main session. Isolated starts a reply in a separate session.",
              { exact: true },
            )
            .isVisible(),
        )
        .toBe(true);

      const target = page.locator("#cron-session-target");
      await target.click();
      await page.getByRole("option", { name: "Its own session", exact: true }).click();
      await expect.poll(() => pickerValue("#cron-session-target")).toBe("isolated");
      await expect.poll(() => pickerValue("#cron-payload-kind")).toBe("agentTurn");
    });
  });
});
