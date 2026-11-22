import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { buildWorkboardMocks } from "../test-helpers/control-ui-workboard-fixtures.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Workboard card reading" });
const fontSize = (element: Locator) =>
  element.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
suite.define(() => {
  it.each([100, 140])(
    "scales card text and keeps all four tabs reachable at text size %i on a phone",
    async (textScale) => {
      await suite.withPage(
        {
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          reducedMotion: "reduce",
          locale: "en-US",
          serviceWorkers: "block",
        },
        async ({ page }) => {
          const fixture = buildWorkboardMocks(1_795_350_000_000, {
            id: "fixture",
            label: "Team member",
          });
          await installNativePluginMockGateway(page, {
            ...workboardUi,
            sessions: fixture.cardSessions,
            methodResponses: fixture.methodResponses,
          });
          await seedChatSettings(page, suite.server.baseUrl, { textScale });
          await page.goto(suite.server.baseUrl + "workboard/peter-tasks");
          const tile = page.locator("article.workboard-card").filter({
            has: page.getByRole("heading", { name: "Draft weekly product brief", exact: true }),
          });
          const scale = textScale / 100;
          const title = tile.locator("h3");
          expect.soft(await fontSize(title)).toBeCloseTo(15 * scale);
          expect
            .soft(await fontSize(tile.locator(".workboard-chip").first()))
            .toBeCloseTo(11 * scale);
          await title.tap();
          const drawer = page.locator(".workboard-detail-drawer");
          expect.soft(await fontSize(drawer.locator("h2"))).toBeCloseTo(20 * scale);
          expect
            .soft(await fontSize(drawer.locator(".workboard-detail__row").first()))
            .toBeCloseTo(12.48 * scale);
          const tabs = drawer.getByRole("tab");
          expect(await tabs.count()).toBe(4);
          expect.soft(await fontSize(tabs.first())).toBeCloseTo(12.8 * scale);
          const bounds = await tabs.evaluateAll((nodes) =>
            nodes.map((node) => {
              const target = node.getBoundingClientRect();
              const owner = node.parentElement!.getBoundingClientRect();
              return target.left >= owner.left && target.right <= owner.right + 1;
            }),
          );
          expect(bounds).toEqual([true, true, true, true]);
          await tabs.last().tap();
          expect(await tabs.last().getAttribute("aria-selected")).toBe("true");
          await page.keyboard.press("Home");
          await page.keyboard.press("ArrowRight");
          expect(
            await drawer.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected"),
          ).toBe("true");
          expect
            .soft(await fontSize(drawer.getByText("No operator notes yet.", { exact: true })))
            .toBeCloseTo(13.12 * scale);
          await page.keyboard.press("Escape");
          await tile.waitFor();
          await expect.poll(() => tile.evaluate((node) => node.matches(":focus"))).toBe(true);
        },
      );
    },
  );
});
