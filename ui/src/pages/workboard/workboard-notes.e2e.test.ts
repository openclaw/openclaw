import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const suite = createControlUiE2eSuite({ name: "Workboard card notes" });
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const command = "pnpm release:check --dry-run";
const notesCard = {
  id: "notes-card",
  title: "Notes selection card",
  notes: `Run this first:\n${command}`,
  labels: [],
  position: 1000,
  priority: "normal",
  status: "todo",
  createdAt: baseTime,
  updatedAt: baseTime,
};
const config = { plugins: { entries: { workboard: { enabled: true } } } };

suite.define(() => {
  it("lets card notes be drag-selected without opening the editor", async () => {
    // A sliding drawer would move the text between measuring and dragging.
    const context = await suite.newBrowserContext({
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, {
        ...workboardUi,
        methodResponses: {
          "config.get": {
            config,
            hash: "workboard-notes-e2e",
            path: "/tmp/openclaw-e2e/openclaw.json",
            raw: JSON.stringify(config),
            resolved: config,
            sourceConfig: config,
          },
          "workboard.cards.list": {
            boards: [{ id: "default", total: 1, active: 1, archived: 0, byStatus: {} }],
            cards: [notesCard],
            statuses: ["todo"],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}workboard`);
      const card = page.locator(".workboard-card", { hasText: notesCard.title });
      await card.hover();
      await card.locator(".workboard-card__menu-trigger").click();
      await card.getByRole("button", { name: "View details", exact: true }).click();
      const notes = page.locator(".workboard-detail__text-trigger--notes");
      await notes.waitFor({ state: "visible" });
      const editor = page.locator("workboard-inline-text textarea");
      const line = await notes.evaluate((element, text) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const start = node.textContent?.indexOf(text) ?? -1;
          if (start >= 0) {
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + text.length);
            const rect = range.getBoundingClientRect();
            return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
          }
        }
        throw new Error("notes text not rendered");
      }, command);
      await page.mouse.move(line.left + 1, line.y);
      await page.mouse.down();
      await page.mouse.move(line.right - 1, line.y, { steps: 5 });
      await page.mouse.up();
      // The base role="button" style disables selection; this proves the notes opt back in.
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(command);
      expect(await editor.count()).toBe(0);

      await page.evaluate(() => document.getSelection()?.removeAllRanges());
      await notes.click();
      await editor.waitFor({ state: "visible" });
      expect(await editor.inputValue()).toBe(notesCard.notes);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
