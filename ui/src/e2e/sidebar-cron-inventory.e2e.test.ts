import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sidebarCronJob } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Compact side rail automation inventory" });
const pageResponse = (offset: number) => ({
  jobs: [
    sidebarCronJob({
      id: `job-${offset}`,
      name: `Report ${offset}`,
      state: { lastRunStatus: offset === 0 ? "ok" : "error", nextRunAtMs: 1 },
    }),
  ],
  snapshotRevision: "inventory",
  total: 2,
  limit: 1,
  offset,
  hasMore: offset === 0,
  nextOffset: offset === 0 ? 1 : null,
});

suite.define(() => {
  it("requests compact automation data on every inventory page", () =>
    suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "cron.list": cronListResponseFixture([
            { match: { offset: 1 }, response: pageResponse(1) },
            { response: pageResponse(0) },
          ]),
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const clock = page.locator('.sidebar-rail [data-sidebar-entry="route:cron"] a');
      await expect
        .poll(() => clock.getAttribute("aria-description"))
        .toBe("An automation has failed");
      await page.locator(".sidebar-issues-button").click();
      const inbox = page.locator("#sidebar-issues-panel");
      await inbox.locator(".sidebar-issues-panel__empty").waitFor();
      expect(await inbox.getByText(/Report [01]/).count()).toBe(0);
      expect((await gateway.getRequests("cron.list")).map(({ params }) => params)).toEqual([
        expect.objectContaining({ compact: true }),
        expect.objectContaining({ compact: true, offset: 1 }),
      ]);
    }));
});
