import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { cronRuns } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron run filter typography E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it("keeps the phone search hint and a long delivery destination readable", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" },
      async ({ page }) => {
        const destination = "atlas-office-" + "calendar".repeat(20);
        await installMockGateway(page, {
          methodResponses: {
            "cron.runs": cronRuns([
              {
                ts: 1,
                jobId: "sync",
                action: "finished",
                status: "error",
                deliveryStatus: "not-delivered",
                deliveryError: "Unknown destination: " + destination,
              },
            ]),
            "cron.status": { enabled: true, jobs: 0 },
          },
        });
        await page.goto(suite.server.baseUrl + "automations?activity");
        const search = page.locator(".cron-run-filter-search");
        const firstFilter = page.locator(".cron-filter-dropdown__trigger").first();
        await firstFilter.waitFor();
        const bottom = await search.evaluate((el) => el.getBoundingClientRect().bottom);
        expect(
          await firstFilter.evaluate((el) => el.getBoundingClientRect().top),
        ).toBeGreaterThanOrEqual(bottom);
        const run = page.locator(".cron-run-entry");
        const header = run.locator(".cron-run-entry__header");
        await header.tap();
        const note = run.locator(".cron-run-entry__delivery-error");
        await note.waitFor();
        expect(await note.textContent()).toContain(destination);
        expect(
          await note.evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const bounds = el.getBoundingClientRect();
            return [...range.getClientRects()].every(
              (line) => line.left >= bounds.left && line.right <= bounds.right + 1,
            );
          }),
        ).toBe(true);
        await header.press("Space");
        await note.waitFor({ state: "hidden" });
      },
    );
  });

  it("keeps dropdown text aligned at mobile and desktop widths", async () => {
    for (const viewport of [
      { height: 844, width: 390 },
      { height: 900, width: 1_280 },
    ]) {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport,
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "cron.list": {
                jobs: [],
                snapshotRevision: "cron-run-filter-typography",
                total: 0,
                offset: 0,
                limit: 50,
                hasMore: false,
                nextOffset: null,
              },
              "cron.runs": cronRuns([]),
              "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
            },
          });

          await page.goto(`${suite.server.baseUrl}cron?activity`);
          const labels = page.locator(
            ".cron-run-filters .cron-filter-dropdown__trigger > .oc-menu-item__label > span",
          );
          await expect.poll(() => labels.count()).toBe(3);
          const fontSizes = await labels.evaluateAll((elements) =>
            elements.map((element) => getComputedStyle(element).fontSize),
          );
          expect(new Set(fontSizes).size).toBe(1);

          await page.getByRole("button", { name: "Sort Newest first", exact: true }).click();
          await page.locator('[data-value="asc"]').click();
          await page.getByRole("button", { name: "Sort Oldest first", exact: true }).waitFor();
          await expect
            .poll(async () =>
              (await gateway.getRequests("cron.runs")).some((request) => {
                const params = request.params;
                return (
                  typeof params === "object" &&
                  params !== null &&
                  "sortDir" in params &&
                  params.sortDir === "asc"
                );
              }),
            )
            .toBe(true);
        },
      );
    }
  });
});
