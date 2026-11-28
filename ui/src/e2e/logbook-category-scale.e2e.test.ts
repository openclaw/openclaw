import { expect, it } from "vitest";
import { logbookStatus, logbookTimeline } from "../pages/plugin/logbook.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Logbook day statistics" });
suite.define(() => {
  it("shows a longer bar for 61 minutes than for 60 minutes", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1180, height: 820 } },
      async ({ page }) => {
        const day = "2026-11-18";
        await page.clock.setFixedTime(new Date(day + "T18:00:00Z"));
        const minute = 60_000;
        const start = Date.parse(day + "T09:00:00Z");
        const timeline = logbookTimeline(
          day,
          [
            {
              id: 1,
              title: "Write the captions",
              category: "writing",
              startMs: start,
              endMs: start + 61 * minute,
            },
            {
              id: 2,
              title: "Design the panels",
              category: "design",
              startMs: start + 61 * minute,
              endMs: start + 121 * minute,
            },
          ],
          121 * minute,
        );
        timeline.stats.categories = [
          { category: "writing", ms: 61 * minute },
          { category: "design", ms: 60 * minute },
        ];
        await installMockGateway(page, {
          communityInvite: false,
          controlUiTabs: [
            { group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" },
          ],
          methodResponses: {
            "logbook.status": logbookStatus(day, { todayCards: 2 }),
            "logbook.timeline": timeline,
          },
        });
        await page.goto(suite.server.baseUrl + "plugin?plugin=logbook&id=logbook");
        await page.locator(".logbook-stats__category-fill").first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        const [longer, shorter] = await page
          .locator(".logbook-stats__category-fill")
          .evaluateAll((bars) => bars.map((bar) => bar.getBoundingClientRect().width));
        expect(shorter).toBeGreaterThan(0);
        expect(longer).toBeGreaterThan(shorter!);
      },
    );
  });
});
