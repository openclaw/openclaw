import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installWorkboardPage } from "./workboard-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Workboard fallback column" });

suite.define(() => {
  it("keeps the fallback choice beside its label in the phone editor", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const columns = [
          {
            id: "working",
            label: "Working",
            description: "Active work",
            match: { run: ["active"] },
          },
          { id: "done", label: "Done", description: "Completed work", fallback: true },
        ];
        const board = { id: "ops", name: "Operations", kind: "sessions", sessions: { columns } };
        const gateway = await installWorkboardPage(page, suite.server.baseUrl, "ops", {
          "workboard.boards.list": { boards: [board] },
          "workboard.cards.list": { boards: [board], cards: [] },
          "workboard.sessionsBoard.read": { board, columns, sessions: [], people: [] },
        });
        await page.goto(suite.server.baseUrl + "workboard/ops");
        await page.locator(".workboard-page-title").hover();
        await page.getByRole("button", { name: "Edit board", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "Edit board" });
        const choices = editor.getByRole("radio", { name: "Fallback column", exact: true });
        await choices.first().waitFor();
        for (const radio of await choices.all()) {
          const { gap, centerOffset, targetHeight } = await radio.evaluate(
            (input: HTMLInputElement) => {
              const label = input.labels![0]!;
              const text = document.createRange();
              text.setStartAfter(input);
              text.setEnd(label, label.childNodes.length);
              const caption = text.getBoundingClientRect();
              const control = input.getBoundingClientRect();
              return {
                gap: caption.left - control.right,
                centerOffset: (caption.top + caption.bottom - control.top - control.bottom) / 2,
                targetHeight: label.getBoundingClientRect().height,
              };
            },
          );
          expect(gap).toBeGreaterThan(0);
          expect(gap).toBeLessThanOrEqual(9);
          expect(Math.abs(centerOffset)).toBeLessThanOrEqual(1);
          expect(targetHeight).toBeGreaterThanOrEqual(44);
        }
        await editor.getByText("Fallback column", { exact: true }).first().click();
        expect(await choices.first().isChecked()).toBe(true);
        await choices.first().press("ArrowDown");
        expect(await choices.last().isChecked()).toBe(true);
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(await gateway.getRequests("workboard.sessionsBoard.update")).toHaveLength(0);
      },
    );
  });
});
