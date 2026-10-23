import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList } from "./cron-fixtures.test-support.ts";

type PerformanceMetrics = { metrics: Array<{ name: string; value: number }> };

function metricDeltas(before: PerformanceMetrics, after: PerformanceMetrics) {
  return Object.fromEntries(
    ["ScriptDuration", "TaskDuration", "LayoutDuration", "RecalcStyleDuration"].map((name) => {
      const earlier = before.metrics.find((entry) => entry.name === name)?.value;
      const later = after.metrics.find((entry) => entry.name === name)?.value;
      if (earlier === undefined || later === undefined) {
        throw new Error(`Missing CDP metric: ${name}`);
      }
      return [name, (later - earlier) * 1000];
    }),
  );
}

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
      await expect.poll(() => rows.count()).toBe(jobs.length);
      const menuClient = await context.newCDPSession(page);
      try {
        await menuClient.send("Performance.enable");
        const before: { metrics: Array<{ name: string; value: number }> } =
          await menuClient.send("Performance.getMetrics");
        const started = performance.now();
        await page.locator(".cron-job-menu__trigger").first().click();
        await page.getByRole("menuitem", { name: "Remove", exact: true }).waitFor();
        const after: typeof before = await menuClient.send("Performance.getMetrics");
        console.log(
          JSON.stringify({
            proof: "cron-expanded-inventory-menu-open",
            jobs: jobs.length,
            elapsedMs: performance.now() - started,
            metrics: Object.fromEntries(
              ["ScriptDuration", "TaskDuration", "LayoutDuration", "RecalcStyleDuration"].map(
                (name) => {
                  const earlier = before.metrics.find((entry) => entry.name === name)?.value;
                  const later = after.metrics.find((entry) => entry.name === name)?.value;
                  if (earlier === undefined || later === undefined) {
                    throw new Error(`Missing CDP metric: ${name}`);
                  }
                  return [name, (later - earlier) * 1000];
                },
              ),
            ),
          }),
        );
        await page.keyboard.press("Escape");
        await page
          .getByRole("menuitem", { name: "Remove", exact: true })
          .waitFor({ state: "hidden" });
      } finally {
        await menuClient.detach();
      }
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
        await client.send("Performance.enable");
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
          const before: PerformanceMetrics = await client.send("Performance.getMetrics");
          const started = performance.now();
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
          const elapsedMs = performance.now() - started;
          const after: PerformanceMetrics = await client.send("Performance.getMetrics");
          expect(await search.inputValue()).toBe(query);
          expect(
            (await gateway.getRequests("cron.list"))
              .slice(requestsBefore)
              .map(({ params }) => (isRecord(params) ? [params.query, params.offset] : null)),
          ).toEqual([[deferredMatch.query, 0]]);
          console.log(
            JSON.stringify({
              proof: "cron-expanded-inventory-pending-query-typing",
              jobs: jobs.length,
              query,
              keystrokes: query.length,
              elapsedMs,
              metrics: metricDeltas(before, after),
            }),
          );
        } finally {
          const complete = new Promise<void>((resolve) => {
            client.once("Tracing.tracingComplete", () => resolve());
          });
          await client.send("Tracing.end");
          await complete;
        }
        expect(await rows.count()).toBe(jobs.length);
        expect(await page.locator(".cron-table").getAttribute("aria-busy")).toBe("true");
        // A loading indicator may restyle itself, not every retained row or shadow part.
        // Count work rather than wall time so the regression is independent of CPU speed.
        expect(recalculated.length).toBeGreaterThan(0);
        expect(Math.max(...recalculated)).toBeLessThan(jobs.length);
        const before: PerformanceMetrics = await client.send("Performance.getMetrics");
        const started = performance.now();
        await gateway.resolveDeferred("cron.list");
        // The pending read queues one replacement for the latest typed query.
        await gateway.waitForRequest("cron.list", { match: { query, offset: 0 } });
        await expect.poll(() => rows.count()).toBe(50);
        await expect.poll(() => page.locator(".cron-table").getAttribute("aria-busy")).toBe(null);
        const elapsedMs = performance.now() - started;
        const after: PerformanceMetrics = await client.send("Performance.getMetrics");
        console.log(
          JSON.stringify({
            proof: "cron-expanded-inventory-search-results",
            jobs: jobs.length,
            query,
            elapsedMs,
            metrics: metricDeltas(before, after),
          }),
        );
        expect(await search.inputValue()).toBe(query);
        expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
        await expect.poll(() => loadMore.isEnabled()).toBe(true);
        await loadMore.click();
        await expect.poll(() => rows.count()).toBe(jobs.length);
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
});
