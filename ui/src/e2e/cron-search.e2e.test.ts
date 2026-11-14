import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList } from "./cron-fixtures.test-support.ts";

// Exercise shipped CSS chunks: a cold source-mode route omits cross-page selectors.
const suite = createControlUiE2eSuite({
  name: "Control UI Cron search bundled Gateway E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps query loading local before replacing an expanded inventory", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page, context }) => {
      const jobs = Array.from({ length: 100 }, (_, index) =>
        cronJob("inventory-" + index, "Inventory reminder " + index, {
          schedule: { kind: "every", everyMs: 3_600_000 },
          payload: { kind: "systemEvent", text: "Synthetic inventory reminder" },
        }),
      );
      const inventoryPage = (offset: number) =>
        cronList(jobs.slice(offset, offset + 50), "inventory-query", {
          total: jobs.length,
          offset,
          hasMore: offset === 0,
          nextOffset: offset === 0 ? 50 : null,
        });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "cron.list": cronListResponseFixture([
            { match: { offset: 50 }, response: inventoryPage(50) },
            { response: inventoryPage(0) },
          ]),
          "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
          "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
        },
      });
      await page.goto(suite.server.baseUrl + "cron");
      const rows = page.locator(".cron-table__row");
      const loadMore = page.getByRole("button", { name: "Load more", exact: true });
      await loadMore.click();
      await expect.poll(() => rows.first().getAttribute("aria-setsize")).toBe(String(jobs.length));
      expect(await rows.count()).toBeLessThan(40);
      await page.locator(".cron-job-menu__trigger").first().click();
      await page.getByRole("menuitem", { name: "Remove", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page
        .getByRole("menuitem", { name: "Remove", exact: true })
        .waitFor({ state: "hidden" });
      const search = page.getByRole("searchbox", { name: "Search automations" });
      await search.click();
      const query = "inventory";
      const deferredMatch = { query: query.slice(0, 1), offset: 0 };
      const requestsBefore = (await gateway.getRequests("cron.list")).length;
      const deferredAfter = await gateway.deferNext("cron.list", deferredMatch);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      const client = await context.newCDPSession(page);
      try {
        const { frameTree } = await client.send("Page.getFrameTree");
        const recalculated: number[] = [];
        client.on("Tracing.dataCollected", ({ value }) => {
          for (const event of value) {
            if (event.name !== "UpdateLayoutTree") {
              continue;
            }
            const args = event.args;
            if (
              isRecord(args) &&
              isRecord(args.beginData) &&
              args.beginData.frame === frameTree.frame.id &&
              typeof args.elementCount === "number"
            ) {
              recalculated.push(args.elementCount);
            }
          }
        });
        await client.send("Tracing.start", {
          categories: "devtools.timeline",
          transferMode: "ReportEvents",
        });
        try {
          await search.press(query.slice(0, 1));
          await gateway.waitForRequest("cron.list", {
            after: deferredAfter,
            match: deferredMatch,
          });
          await search.pressSequentially(query.slice(1));
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          expect(await search.inputValue()).toBe(query);
          expect(
            (await gateway.getRequests("cron.list"))
              .slice(requestsBefore)
              .map(({ params }) => (isRecord(params) ? [params.query, params.offset] : null)),
          ).toEqual([[deferredMatch.query, 0]]);
        } finally {
          const complete = new Promise<void>((resolve) => {
            client.once("Tracing.tracingComplete", () => resolve());
          });
          await client.send("Tracing.end");
          await complete;
        }
        expect(await rows.first().getAttribute("aria-setsize")).toBe(String(jobs.length));
        expect(await rows.count()).toBeLessThan(40);
        expect(await page.locator(".cron-table").getAttribute("aria-busy")).toBe("true");
        // A loading indicator may restyle itself, not every retained row or shadow part.
        // Count work rather than wall time so the regression is independent of CPU speed.
        expect(recalculated.length).toBeGreaterThan(0);
        expect(Math.max(...recalculated)).toBeLessThan(jobs.length);
        await gateway.resolveDeferred("cron.list");
        // The pending read queues one replacement for the latest typed query.
        await gateway.waitForRequest("cron.list", { match: { query, offset: 0 } });
        await expect.poll(() => rows.first().getAttribute("aria-setsize")).toBe("50");
        await expect.poll(() => page.locator(".cron-table").getAttribute("aria-busy")).toBe(null);
        expect(await search.inputValue()).toBe(query);
        expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
        await expect.poll(() => loadMore.isEnabled()).toBe(true);
        await loadMore.click();
        await expect
          .poll(() => rows.first().getAttribute("aria-setsize"))
          .toBe(String(jobs.length));
        expect(await rows.count()).toBeLessThan(40);
        expect(
          (await gateway.getRequests("cron.list"))
            .slice(requestsBefore)
            .map(({ params }) => (isRecord(params) ? [params.query, params.offset] : null)),
        ).toEqual([
          [deferredMatch.query, 0],
          [query, 0],
          [query, 50],
        ]);
      } finally {
        await client.detach();
      }
    });
  });
  it.each([
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ])(
    "windows jobs while preserving native Tab, menu focus, and the last loaded job at %o",
    async (viewport) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const jobs = Array.from({ length: 500 }, (_, index) =>
          cronJob("window-" + index, "Windowed reminder " + index),
        );
        await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponseFixture(
              Array.from({ length: 10 }, (_, pageIndex) => {
                const offset = pageIndex * 50;
                return {
                  match: { offset },
                  response: cronList(jobs.slice(offset, offset + 50), "window-query", {
                    total: jobs.length,
                    offset,
                    hasMore: offset + 50 < jobs.length,
                    nextOffset: offset + 50 < jobs.length ? offset + 50 : null,
                  }),
                };
              }),
            ),
            "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
            "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
          },
        });
        await page.goto(suite.server.baseUrl + "cron");
        const rows = page.locator(".cron-table__row");
        for (let count = 50; count <= jobs.length; count += 50) {
          await expect.poll(() => rows.first().getAttribute("aria-setsize")).toBe(String(count));
          if (count < jobs.length) {
            await page.getByRole("button", { name: "Load more", exact: true }).press("Enter");
          }
        }
        expect(await rows.count()).toBeLessThan(40);
        // The last row is pinned as the native reverse-Tab entry from the footer.
        const edge = rows.nth((await rows.count()) - 2);
        const index = Number(await edge.getAttribute("data-index"));
        await edge.locator(".cron-table__name").focus();
        for (let step = 0; step < 4; step++) {
          await page.keyboard.press("Tab");
        }
        const next = page.locator(`[data-test-id="cron-row-window-${index + 1}"]`);
        await expect
          .poll(() =>
            next
              .locator(".cron-table__name")
              .evaluate((element) => element === document.activeElement),
          )
          .toBe(true);
        const trigger = next.locator(".cron-job-menu__trigger");
        await trigger.click();
        await page.getByRole("menuitem", { name: "Remove", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
        const lastName = page.locator('[data-test-id="cron-row-window-499"] .cron-table__name');
        await lastName.focus();
        await expect
          .poll(() =>
            lastName.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return rect.top >= 0 && rect.bottom <= innerHeight;
            }),
          )
          .toBe(true);
        await expect
          .poll(() =>
            page.locator('[data-test-id="cron-row-window-499"]').getAttribute("aria-posinset"),
          )
          .toBe("500");
        expect(await rows.count()).toBeLessThan(40);
      });
    },
  );
});
