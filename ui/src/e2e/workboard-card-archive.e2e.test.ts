import { expect, it } from "vitest";
import { makeBoard, makeCard } from "../pages/workboard/workboard.e2e.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installWorkboardPage } from "./workboard-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Single card archive" });
const method = "workboard.cards.archive";

suite.define(() => {
  it("projects an archive or restore into the current filter without rolling back a newer interaction", async () => {
    await suite.withPage(
      { viewport: { width: 1180, height: 700 }, reducedMotion: "reduce", locale: "en-US" },
      async ({ page }) => {
        const board = makeBoard("release", { name: "Release checklist" });
        const card = makeCard({
          id: "checklist",
          title: "Retire the old checklist",
          metadata: { automation: { boardId: board.id } },
        });
        const next = { ...card, id: "notes", title: "Review the release notes", position: 2000 };
        const gateway = await installWorkboardPage(page, suite.server.baseUrl, board.id, {
          "workboard.boards.list": { boards: [board] },
          "workboard.cards.list": { boards: [board], cards: [card, next], statuses: ["todo"] },
        });
        await page.goto(suite.server.baseUrl + "workboard/release");
        const row = page.locator(".workboard-card", { hasText: card.title });
        const neighbor = page.locator(".workboard-card", { hasText: next.title });
        const act = async (archived: boolean) => {
          const after = await gateway.deferNext(method);
          await row.hover();
          await row.getByRole("button", { name: "Card actions" }).click();
          await page
            .getByRole("button", {
              name: archived ? "Archive card" : "Restore from archive",
              exact: true,
            })
            .click();
          expect((await gateway.waitForRequest(method, { after })).params).toMatchObject({
            id: card.id,
            archived,
          });
        };
        const toggleArchived = async () => {
          await page.locator(".workboard-filter-trigger").click();
          const filters = page.getByRole("dialog", { name: "Filters", exact: true });
          await filters.getByRole("switch", { name: "Show archived" }).click();
          await filters.getByRole("button", { name: "Close", exact: true }).click();
        };
        await act(true);
        expect(await row.count()).toBe(0);
        expect(await neighbor.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.keyboard.press("Enter");
        const message = "The card could not be archived.";
        await gateway.rejectDeferred(method, { code: "UNAVAILABLE", message });
        const nextDetails = page.getByRole("dialog", { name: next.title });
        await nextDetails.getByText(message, { exact: true }).waitFor();
        expect(await page.locator(".workboard-card").allTextContents()).toEqual([
          expect.stringContaining(card.title),
          expect.stringContaining(next.title),
        ]);
        await page.keyboard.press("Escape");
        await act(true);
        await gateway.resolveDeferred(method, {
          card: { ...card, metadata: { ...card.metadata, archivedAt: 2 } },
        });
        await toggleArchived();
        await act(false);
        await toggleArchived();
        expect(await row.count()).toBe(1);
        await gateway.rejectDeferred(method, {
          code: "UNAVAILABLE",
          message: "The card could not be restored.",
        });
        await row.waitFor({ state: "detached" });
        await toggleArchived();
        await act(false);
        await toggleArchived();
        await gateway.resolveDeferred(method, { card });
        await expect.poll(() => page.locator(".workboard-refresh").isEnabled()).toBe(true);
        expect(await row.count()).toBe(1);
      },
    );
  });
});
