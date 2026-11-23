import { expect, it } from "vitest";
import { logbookStatus, logbookTimeline } from "../pages/plugin/logbook.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Logbook app domains" });
suite.define(() => {
  it("keeps long domains on one line with their distinct endings and full identities", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1180, height: 820 } },
      async ({ page }) => {
        const day = "2026-11-18";
        await page.clock.setFixedTime(new Date(day + "T18:00:00Z"));
        const domain = "exhibitionaccessibilityreview.previewcollection.museum.example";
        const trackedMs = 61 * 60_000;
        const timeline = logbookTimeline(day, [{ appPrimary: domain }], trackedMs);
        const domains = [domain, domain.replace("museum", "gallery"), "studio.example"];
        timeline.stats.apps = domains.map((name) => ({ domain: name, ms: trackedMs / 3 }));
        await installMockGateway(page, {
          communityInvite: false,
          controlUiTabs: [
            { group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" },
          ],
          methodResponses: { "logbook.status": logbookStatus(day), "logbook.timeline": timeline },
        });
        await page.goto(suite.server.baseUrl + "plugin?plugin=logbook&id=logbook");
        const apps = page.locator(".logbook-stats__apps");
        const labels = apps.locator(".logbook-stats__app");
        await labels.last().waitFor();
        await page.evaluate(() => document.fonts.ready);
        const chips = await labels.evaluateAll((nodes) =>
          nodes.map((node) => ({
            full: node.getAttribute("title"),
            text: node.textContent,
            height: node.getBoundingClientRect().height,
            right: node.getBoundingClientRect().right,
            truncated: node.scrollWidth > node.clientWidth,
            direction: getComputedStyle(node).direction,
            overflow: getComputedStyle(node).textOverflow,
          })),
        );
        expect(chips.map((chip) => chip.full)).toEqual(domains);
        expect(chips.map((chip) => chip.text)).toEqual(domains);
        const right = await apps.evaluate((el) => el.getBoundingClientRect().right);
        for (const chip of chips.slice(0, 2)) {
          expect(chip.height).toBe(chips[2]!.height);
          expect(chip.right).toBeLessThanOrEqual(right + 1);
          expect(chip.truncated).toBe(true);
          expect(chip.direction).toBe("rtl");
          expect(chip.overflow).toBe("ellipsis");
        }
        expect(chips[2]!.truncated).toBe(false);
      },
    );
  });
});
