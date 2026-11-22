import { expect, it } from "vitest";
import { logbookStatus, logbookTimeline } from "../pages/plugin/logbook.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Logbook app domains" });
suite.define(() => {
  it("shows the entire app domain inside the day summary", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1180, height: 820 } },
      async ({ page }) => {
        const day = "2026-11-18";
        await page.clock.setFixedTime(new Date(day + "T18:00:00Z"));
        const domain = "exhibitionaccessibilityreview.previewcollection.museum.example";
        const trackedMs = 61 * 60_000;
        const timeline = logbookTimeline(day, [{ appPrimary: domain }], trackedMs);
        timeline.stats.apps = [{ domain, ms: trackedMs }];
        await installMockGateway(page, {
          communityInvite: false,
          controlUiTabs: [
            { group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" },
          ],
          methodResponses: { "logbook.status": logbookStatus(day), "logbook.timeline": timeline },
        });
        await page.goto(suite.server.baseUrl + "plugin?plugin=logbook&id=logbook");
        const apps = page.locator(".logbook-stats__apps");
        const label = apps.getByText(domain, { exact: true });
        await label.waitFor();
        await page.evaluate(() => document.fonts.ready);
        const textEnd = await label.evaluate((el) => {
          const text = document.createRange();
          text.selectNodeContents(el);
          return text.getBoundingClientRect().right;
        });
        expect(textEnd).toBeLessThanOrEqual(
          await apps.evaluate((el) => el.getBoundingClientRect().right),
        );
      },
    );
  });
});
