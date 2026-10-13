import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Exercise shipped CSS chunks: a cold source-mode route omits cross-page selectors.
const suite = createControlUiE2eSuite({
  name: "Control UI Cron search bundled Gateway E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps query loading local before replacing an expanded inventory", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page, context }) => {
      const jobs: CronJob[] = Array.from({ length: 100 }, (_, index) => ({
        id: "inventory-" + index,
        name: "Inventory reminder " + index,
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Synthetic inventory reminder" },
        state: {},
      }));
      const inventoryPage = (offset: number) => ({
        jobs: jobs.slice(offset, offset + 50),
        snapshotRevision: "inventory-query",
        total: jobs.length,
        offset,
        limit: 50,
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
      const search = page.getByRole("searchbox", { name: "Search automations" });
      await search.click();
      await gateway.deferNext("cron.list", { query: "i" });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      const client = await context.newCDPSession(page);
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
        await search.press("i");
        await gateway.waitForRequest("cron.list", { match: { query: "i", offset: 0 } });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
      } finally {
        const complete = new Promise<void>((resolve) => {
          client.once("Tracing.tracingComplete", () => resolve());
        });
        await client.send("Tracing.end");
        await complete;
        await client.detach();
      }
      expect(await rows.count()).toBe(jobs.length);
      expect(await page.locator(".cron-table").getAttribute("aria-busy")).toBe("true");
      // A loading indicator may restyle itself, not every retained row or shadow part.
      // Count work rather than wall time so the regression is independent of CPU speed.
      expect(recalculated.length).toBeGreaterThan(0);
      expect(Math.max(...recalculated)).toBeLessThan(jobs.length);
      await gateway.resolveDeferred("cron.list");
      await expect.poll(() => rows.count()).toBe(50);
      expect(await search.inputValue()).toBe("i");
      expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
      await expect.poll(() => loadMore.isEnabled()).toBe(true);
      await loadMore.click();
      await expect.poll(() => rows.count()).toBe(jobs.length);
      expect(
        (await gateway.getRequests("cron.list", { query: "i" })).map(
          ({ params }) => isRecord(params) && params.offset,
        ),
      ).toEqual([0, 50]);
    });
  });
});
