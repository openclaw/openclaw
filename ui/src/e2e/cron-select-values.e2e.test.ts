import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { pickerValue as readPickerValue } from "../test-helpers/select-picker-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList, cronRuns } from "./cron-fixtures.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

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
    "cron.runs": cronRuns([]),
    "cron.status": { enabled, jobs: jobs.length, nextWakeAtMs: null },
  };
}

const scrollPadding = (page: Page) =>
  page.locator(".content").evaluate((element) => getComputedStyle(element).scrollPaddingBlockEnd);

suite.define(() => {
  it.each([
    { mode: "create", enabled: true, keyboardName: true, narrow: false },
    { mode: "create", enabled: false, keyboardName: false, narrow: false },
    { mode: "create", enabled: true, keyboardName: true, narrow: true },
    { mode: "edit", enabled: true, keyboardName: true, narrow: true },
  ])(
    "keeps actions at the scrollport edge and keyboard choices clear ($mode, scheduler $enabled, narrow $narrow)",
    async ({ mode, enabled, keyboardName, narrow }) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1416, height: 707 } },
        async ({ page }) => {
          const job = gardenJob();
          const gateway = await installMockGateway(page, {
            methodResponses: cronResponses([job], "focus-clearance", enabled),
          });
          await page.goto(`${suite.server.baseUrl}cron`);
          const scroller = page.locator(".content");
          const initialPadding = await scrollPadding(page);
          await page
            .locator(
              mode === "edit"
                ? '[data-test-id="cron-row-garden-keyboard"]'
                : '[data-test-id="cron-new-task"]',
            )
            .click();
          await page.evaluate(() => document.fonts.ready);
          if (narrow) {
            const footer = page.locator(".cron-editor-actions");
            const originalHeight = await footer.evaluate(
              (element) => element.getBoundingClientRect().height,
            );
            await page.setViewportSize({ width: 390, height: 707 });
            await expect
              .poll(() => footer.evaluate((element) => element.getBoundingClientRect().height))
              .toBeGreaterThan(originalHeight);
          }
          // Keyboard focus uses the scroll padding published by ResizeObserver.
          // A taller footer alone does not mean that clearance has been applied.
          await expect
            .poll(() =>
              scroller.evaluate((element) => {
                const footer = document.querySelector(".cron-editor-actions");
                if (!footer) {
                  return false;
                }
                const style = getComputedStyle(element);
                const expected =
                  footer.getBoundingClientRect().height + Number.parseFloat(style.paddingBlockEnd);
                return Math.abs(Number.parseFloat(style.scrollPaddingBlockEnd) - expected) < 0.01;
              }),
            )
            .toBe(true);
          await page.locator("#cron-payload-text").fill(gardenMessage);
          if (keyboardName) {
            for (let field = 0; field < 4; field++) {
              await page.keyboard.press("Tab");
            }
            expect(
              await page.locator("#cron-name").evaluate((element) => element.matches(":focus")),
            ).toBe(true);
            await page.keyboard.type("Garden keyboard task");
          } else {
            await page.locator("#cron-name").fill("Garden keyboard task");
          }
          await page.keyboard.press("Tab");
          await page.keyboard.press("Tab");
          await page.keyboard.press("Tab");
          const interval = page.locator('[data-test-id="cron-schedule-kind-every"]');
          expect(await interval.evaluate((element) => element.matches(":focus-within"))).toBe(true);
          await page.keyboard.press("ArrowRight");
          const once = page.locator('[data-test-id="cron-schedule-kind-at"]');
          await page.locator("#cron-schedule-at").waitFor({ state: "visible" });
          expect(await once.evaluate((element) => element.matches(":focus-within"))).toBe(true);
          const geometry = await once.evaluate((element) => {
            const choice = element.getBoundingClientRect();
            const actions = document.querySelector(".cron-editor-actions");
            if (!actions) {
              throw new Error("Automation editor actions are missing");
            }
            const footer = actions.getBoundingClientRect();
            const hit = document.elementFromPoint(
              choice.x + choice.width / 2,
              choice.y + choice.height / 2,
            );
            return {
              bottom: choice.bottom,
              top: choice.top,
              footerTop: footer.top,
              footerBottom: footer.bottom,
              scrollportBottom: document.querySelector(".content")!.getBoundingClientRect().bottom,
              reachable: hit === element || (hit !== null && element.contains(hit)),
            };
          });
          expect(geometry.top).toBeGreaterThanOrEqual(0);
          expect(geometry.bottom).toBeLessThanOrEqual(geometry.footerTop);
          expect(geometry.reachable).toBe(true);
          expect(Math.abs(geometry.footerBottom - geometry.scrollportBottom)).toBeLessThan(1);
          if (narrow && mode === "create") {
            const buttonTops = await page
              .locator(".cron-editor-actions > button")
              .evaluateAll((buttons) =>
                buttons.map((button) => button.getBoundingClientRect().top),
              );
            expect(new Set(buttonTops).size).toBeGreaterThan(1);
          }
          await scroller.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          const bottomGap = await page.locator(".cron-editor-actions").evaluate((element) => {
            const scrollport = element.closest(".content")!;
            return (
              scrollport.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom
            );
          });
          expect(Math.abs(bottomGap)).toBeLessThan(1);
          for (const method of ["cron.add", "cron.update", "cron.run"]) {
            expect(await gateway.getRequests(method)).toHaveLength(0);
          }
          await page
            .locator(".cron-editor-actions")
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await expect.poll(() => scrollPadding(page)).toBe(initialPadding);
          await page.locator('[data-test-id="cron-new-task"]').click();
          await expect.poll(() => scrollPadding(page)).not.toBe(initialPadding);
          if (narrow) {
            await page.setViewportSize({ width: 1416, height: 707 });
          }
          const pages = await openSidebarPages(page);
          await pages.getByRole("link", { name: "Sessions", exact: true }).click();
          await expect.poll(() => scrollPadding(page)).toBe(initialPadding);
        },
      );
    },
  );

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
        await page.locator('[data-test-id="cron-row-garden-legacy-delivery"]').click();
        await page.locator("#cron-name").fill("Renamed garden summary");
        const mode = page.locator("#cron-delivery-mode");
        await mode.scrollIntoViewIfNeeded();
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
        methodResponses: cronResponses([], "cron-select-values-fixture", true, false),
      });

      const response = await page.goto(`${suite.server.baseUrl}cron`);
      expect(response?.status()).toBe(200);
      await page.locator('[data-test-id="cron-list-tab-activity"]').click();
      const sortMenu = page.locator(".cron-filter-dropdown__details", {
        has: page.locator(".cron-run-sort"),
      });
      const sort = page.getByRole("button", { name: "Sort Newest first", exact: true });
      await sort.waitFor({ state: "visible" });
      await sort.click();
      await sortMenu.locator('[data-value="asc"]').click();
      await page.getByRole("button", { name: "Sort Oldest first", exact: true }).waitFor();
      // Switching tabs recreates the dropdown with the persisted non-first value.
      await page.locator('[data-test-id="cron-tab-all"]').click();
      await page.locator('[data-test-id="cron-list-tab-activity"]').click();
      await page.getByRole("button", { name: "Sort Oldest first", exact: true }).waitFor();
      expect(await sortMenu.locator('[data-value="asc"]').getAttribute("aria-current")).toBe(
        "true",
      );
      await page.locator('[data-test-id="cron-new-task"]').click();

      const pickerValue = (selector: string) =>
        readPickerValue(page.locator(`openclaw-select-picker:has(${selector})`));
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
      await page.getByRole("option", { name: "Post to main timeline", exact: true }).click();
      await expect.poll(() => pickerValue("#cron-payload-kind")).toBe("systemEvent");
      await expect.poll(() => pickerValue("#cron-session-target")).toBe("main");

      const target = page.locator("#cron-session-target");
      await target.click();
      await page.getByRole("option", { name: "Isolated session", exact: true }).click();
      await expect.poll(() => pickerValue("#cron-session-target")).toBe("isolated");
      await expect.poll(() => pickerValue("#cron-payload-kind")).toBe("agentTurn");
    });
  });
});
