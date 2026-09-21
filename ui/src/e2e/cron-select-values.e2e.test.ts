// Control UI tests cover Automations form select display state.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { pickerValue as readPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron select values mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it.each([
    { mode: "create", enabled: true, keyboardName: true, narrow: false },
    { mode: "create", enabled: false, keyboardName: false, narrow: false },
    { mode: "create", enabled: true, keyboardName: true, narrow: true },
    { mode: "edit", enabled: true, keyboardName: true, narrow: true },
  ])(
    "keeps keyboard schedule choices clear of actions ($mode, scheduler $enabled, narrow $narrow)",
    async ({ mode, enabled, keyboardName, narrow }) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1416, height: 707 } },
        async ({ page }) => {
          const job: CronJob = {
            id: "garden-keyboard",
            name: "Garden keyboard task",
            enabled: true,
            createdAtMs: 0,
            updatedAtMs: 0,
            configRevision: "garden-revision",
            schedule: { kind: "every", everyMs: 1_800_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "Summarize the fictional garden inventory." },
            state: {},
          };
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "cron.list": cronListResponseFixture({
                jobs: [job],
                snapshotRevision: "focus-clearance",
                total: 1,
                offset: 0,
                limit: 50,
                hasMore: false,
                nextOffset: null,
              }),
              "cron.runs": {
                entries: [],
                total: 0,
                offset: 0,
                limit: 50,
                hasMore: false,
                nextOffset: null,
              },
              "cron.status": { enabled, jobs: 1, nextWakeAtMs: null },
            },
          });
          await page.goto(`${suite.server.baseUrl}cron`);
          const scroller = page.locator(".content");
          const initialPadding = await scroller.evaluate(
            (element) => getComputedStyle(element).scrollPaddingBlockEnd,
          );
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
          await page
            .locator("#cron-payload-text")
            .fill("Summarize the fictional garden inventory.");
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
          await page.screenshot({ path: path.join(suite.artifactDir, "keyboard-once.png") });
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
              footerHeight: footer.height,
              reachable: hit === element || (hit !== null && element.contains(hit)),
            };
          });
          writeFileSync(
            path.join(suite.artifactDir, "keyboard-geometry.json"),
            JSON.stringify(geometry, null, 2),
          );
          expect(geometry.top).toBeGreaterThanOrEqual(0);
          expect(geometry.bottom).toBeLessThanOrEqual(geometry.footerTop);
          expect(geometry.reachable).toBe(true);
          if (narrow && mode === "create") {
            const buttonTops = await page
              .locator(".cron-editor-actions > button")
              .evaluateAll((buttons) =>
                buttons.map((button) => button.getBoundingClientRect().top),
              );
            expect(new Set(buttonTops).size).toBeGreaterThan(1);
          }
          for (const method of ["cron.add", "cron.update", "cron.run"]) {
            expect(await gateway.getRequests(method)).toHaveLength(0);
          }
          await page
            .locator(".cron-editor-actions")
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await expect
            .poll(() =>
              scroller.evaluate((element) => getComputedStyle(element).scrollPaddingBlockEnd),
            )
            .toBe(initialPadding);
          await page.locator('[data-test-id="cron-new-task"]').click();
          await expect
            .poll(() =>
              scroller.evaluate((element) => getComputedStyle(element).scrollPaddingBlockEnd),
            )
            .not.toBe(initialPadding);
          if (narrow) {
            await page.setViewportSize({ width: 1416, height: 707 });
          }
          await page.getByRole("link", { name: "Agents", exact: true }).click();
          await expect
            .poll(() =>
              scroller.evaluate((element) => getComputedStyle(element).scrollPaddingBlockEnd),
            )
            .toBe(initialPadding);
        },
      );
    },
  );

  it("shows the authoritative defaults in the create-form selects", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "cron.list": {
              jobs: [],
              snapshotRevision: "cron-select-values-fixture",
              total: 0,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "cron.runs": {
              entries: [],
              total: 0,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}cron`);
        expect(response?.status()).toBe(200);
        await page.locator('[data-test-id="cron-list-tab-activity"]').click();
        const sortMenu = page.locator("wa-dropdown", { has: page.locator(".cron-run-sort") });
        const sort = page.getByRole("button", { name: "Sort Newest first", exact: true });
        await sort.waitFor({ state: "visible" });
        await sort.click();
        await sortMenu.locator('wa-dropdown-item[value="asc"]').click();
        await page.getByRole("button", { name: "Sort Oldest first", exact: true }).waitFor();
        // Switching tabs recreates the dropdown with the persisted non-first value.
        await page.locator('[data-test-id="cron-tab-all"]').click();
        await page.locator('[data-test-id="cron-list-tab-activity"]').click();
        await page.getByRole("button", { name: "Sort Oldest first", exact: true }).waitFor();
        expect(
          await sortMenu.locator('wa-dropdown-item[value="asc"]').getAttribute("aria-current"),
        ).toBe("true");
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
      },
    );
  });
});
