import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installWorkboardPage } from "./workboard-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Workboard inline card properties" });
suite.define(() => {
  it("previews inline properties and recovers rejected edits from the Gateway", async () => {
    await suite.withPage(
      { viewport: { width: 1120, height: 760 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const board = {
          id: "ops",
          name: "Operations",
          total: 1,
          active: 1,
          archived: 0,
          byStatus: { todo: 1 },
        };
        const card = {
          id: "release-checklist",
          title: "Review the release checklist",
          notes: "Verify the release notes and check the rollout plan before Thursday.",
          agentId: "main",
          priority: "normal",
          labels: ["release"],
          status: "todo",
          createdAt: 1795730400000,
          updatedAt: 1795730400000,
          position: 1000,
          metadata: { automation: { boardId: board.id } },
        };
        const gateway = await installWorkboardPage(page, suite.server.baseUrl, board.id, {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [
              { id: "main", name: "OpenClaw" },
              { id: "editor", name: "Editor" },
            ],
          },
          "workboard.boards.list": { boards: [board] },
          "workboard.cards.list": { cards: [card], boards: [board], statuses: ["todo", "done"] },
        });
        await page.goto(suite.server.baseUrl + "workboard/ops");
        await page.locator(".workboard-card", { hasText: card.title }).click();
        const detail = page.locator(".workboard-detail");
        const trigger = detail.locator("button.workboard-detail__priority");
        const method = "workboard.cards.update";
        const high = detail.getByText("High", { exact: true });
        const after = await gateway.deferNext(method);
        await trigger.click();
        await high.click();
        expect((await gateway.waitForRequest(method, { after })).params).toEqual({
          id: card.id,
          expectedUpdatedAt: card.updatedAt,
          patch: { priority: "high" },
        });
        const tile = page.locator(".workboard-card", { hasText: card.title });
        await expect.poll(() => trigger.textContent()).toContain("High");
        expect(await trigger.isDisabled()).toBe(true);
        expect(await tile.getAttribute("class")).toContain("priority-high");
        const activity = detail.getByRole("tab", { name: "Activity" });
        await activity.click();
        const newer = { ...card, priority: "low", updatedAt: card.updatedAt + 1 };
        await gateway.rejectDeferred(method, {
          code: "workboard_conflict",
          message: "This card changed. Review it and try again.",
          details: { type: "workboard_card_conflict", card: newer },
        });
        await page.getByRole("alert").filter({ hasText: "This card changed" }).waitFor();
        expect(await activity.evaluate((el) => el === document.activeElement)).toBe(true);
        await detail.getByRole("tab", { name: "Overview" }).click();
        await expect.poll(() => trigger.textContent()).toContain("Low");
        const retry = await gateway.deferNext(method);
        await trigger.click();
        await high.click();
        expect((await gateway.waitForRequest(method, { after: retry })).params).toEqual({
          id: card.id,
          expectedUpdatedAt: newer.updatedAt,
          patch: { priority: "high" },
        });
        await gateway.resolveDeferred(method, {
          card: { ...newer, priority: "high", updatedAt: newer.updatedAt + 1 },
        });
        await expect.poll(() => trigger.isEnabled()).toBe(true);
        await trigger.click();
        expect(await detail.getByRole("radio", { name: "High" }).isChecked()).toBe(true);
        await page.keyboard.press("Escape");
        const agent = detail.locator(".workboard-detail__agent-picker .agent-select__trigger");
        const reassign = await gateway.deferNext(method);
        await agent.click();
        await page.getByRole("option", { name: "Editor" }).click();
        await gateway.waitForRequest(method, { after: reassign });
        await expect.poll(() => agent.textContent()).toContain("Editor");
        await gateway.rejectDeferred(method, { message: "Assignment failed." });
        await expect.poll(() => agent.textContent()).toContain("OpenClaw");
        const labels = detail.locator(".workboard-detail__text-trigger--labels");
        await labels.click();
        const picker = detail.getByRole("dialog", { name: "Labels" });
        const search = picker.getByRole("searchbox");
        await search.fill("rollout");
        await search.press("Enter");
        expect(await picker.getByRole("checkbox", { name: "rollout" }).isChecked()).toBe(true);
        const saveLabels = await gateway.deferNext(method);
        await picker.getByRole("button", { name: "Save" }).click();
        expect((await gateway.waitForRequest(method, { after: saveLabels })).params).toMatchObject({
          patch: { labels: ["release", "rollout"] },
        });
        await expect.poll(() => labels.textContent()).toContain("rollout");
        expect(await picker.isVisible()).toBe(false);
        await gateway.rejectDeferred(method, { message: "Labels could not be saved." });
        await page.getByRole("alert").filter({ hasText: "Labels could not be saved" }).waitFor();
        expect(await labels.textContent()).not.toContain("rollout");
        await expect.poll(() => labels.evaluate((el) => el === document.activeElement)).toBe(true);
        await labels.click();
        expect(await picker.getByRole("checkbox", { name: "rollout" }).isChecked()).toBe(true);
      },
    );
  });
});
