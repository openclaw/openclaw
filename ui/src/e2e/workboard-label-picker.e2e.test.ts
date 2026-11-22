import { expect, it } from "vitest";
import { makeBoard, makeCard } from "../pages/workboard/workboard.e2e.test-support.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Workboard label picker" });

suite.define(() => {
  it("keeps the upward label picker attached and its controls still while filtering", async () => {
    await suite.withPage(
      {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const board = makeBoard("ops", { total: 1, active: 1, byStatus: { triage: 1 } });
        const card = makeCard({
          id: "captions",
          title: "Review the gallery entrance captions",
          status: "triage",
          agentId: "main",
          metadata: { automation: { boardId: "ops" } },
          labels: Array.from({ length: 12 }, (_, i) => `Gallery conservation review ${i + 1}`),
        });
        await installNativePluginMockGateway(page, {
          ...workboardUi,
          methodResponses: {
            "workboard.boards.list": { boards: [board] },
            "workboard.cards.list": {
              boards: [board],
              cards: [card],
              statuses: ["triage", "done"],
            },
            "workboard.cards.diagnostics.refresh": { diagnostics: [], count: 0 },
          },
        });
        await page.goto(suite.server.baseUrl + "workboard/ops");
        await page.locator(".workboard-card", { hasText: card.title }).tap();
        const trigger = page.locator(".workboard-detail__text-trigger--labels");
        // Tap the visible field without scrolling the drawer to center the whole chip group.
        await trigger.waitFor();
        const anchor = (await trigger.boundingBox())!;
        const x = anchor.x + anchor.width / 2,
          y = anchor.y + anchor.height / 2;
        await expect
          .poll(() =>
            trigger.evaluate(
              (el, point) => el.contains(document.elementFromPoint(point.x, point.y)),
              { x, y },
            ),
          )
          .toBe(true);
        await page.touchscreen.tap(x, y);
        const panel = page.getByRole("dialog", { name: "Labels", exact: true });
        const search = panel.getByRole("searchbox"),
          save = panel.getByRole("button", { name: "Save" });
        const gap = async () =>
          (await trigger.boundingBox())!.y -
          (await panel.evaluate((el) => el.getBoundingClientRect().bottom));
        await expect.poll(gap).toBeCloseTo(6, 0);
        const searchY = (await search.boundingBox())!.y;
        const saveY = (await save.boundingBox())!.y;
        const firstChoice = panel.getByRole("checkbox").first();
        const firstChoiceY = (await firstChoice.boundingBox())!.y;
        for (const query of ["review 12", ""]) {
          await search.fill(query);
          await expect.poll(() => panel.getByRole("checkbox").count()).toBe(query ? 1 : 12);
          await expect.poll(gap).toBeCloseTo(6, 0);
          expect((await search.boundingBox())!.y).toBeCloseTo(searchY, 0);
          expect((await save.boundingBox())!.y).toBeCloseTo(saveY, 0);
          expect((await firstChoice.boundingBox())!.y).toBeCloseTo(firstChoiceY, 0);
          expect(
            await save.evaluate((el) => {
              const r = el.getBoundingClientRect();
              return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            }),
          ).toBe(true);
        }
      },
    );
  });
});
