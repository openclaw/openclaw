import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sidebarCronJob } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Compact Inbox automation inventory" });
const pageResponse = (offset: number) => ({
  jobs: [sidebarCronJob({ id: `job-${offset}`, name: `Report ${offset}` })],
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
      await expect
        .poll(() => page.locator(".sidebar-issues-button__count").textContent())
        .toBe("2");
      expect((await gateway.getRequests("cron.list")).map(({ params }) => params)).toEqual([
        expect.objectContaining({ compact: true }),
        expect.objectContaining({ compact: true, offset: 1 }),
      ]);
    }));
});
