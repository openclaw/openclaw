import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installWorkboardPage } from "./workboard-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Workboard request changes" });

suite.define(() => {
  it("starts a new attempt from the same completed card", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const boardId = "samples";
        const sessionKey = "agent:main:subagent:workboard-samples-review-sample";
        const instructions = "Check the totals against the second fictional sample.";
        const card = {
          id: "review-sample",
          title: "Review sample totals",
          status: "done",
          priority: "normal",
          labels: [],
          position: 1000,
          createdAt: 1,
          updatedAt: 2,
          sessionKey,
          runId: "first-attempt",
          execution: {
            id: "sample-execution",
            kind: "agent-session",
            mode: "autonomous",
            status: "done",
            startedAt: 1,
            updatedAt: 2,
            sessionKey,
            runId: "first-attempt",
          },
          metadata: { automation: { boardId } },
        };
        const boards = [{ id: boardId, name: "Samples", total: 1, active: 1, archived: 0 }];
        const gateway = await installWorkboardPage(page, suite.server.baseUrl, boardId, {
          "workboard.boards.list": { boards },
          "workboard.cards.list": { boards, cards: [card], statuses: ["running", "done"] },
          "workboard.cards.start": {
            card: {
              ...card,
              status: "running",
              updatedAt: 3,
              runId: "second-attempt",
              execution: { ...card.execution, status: "running", runId: "second-attempt" },
            },
          },
        });
        await page.goto(suite.server.baseUrl + "workboard/" + boardId);
        await page.locator(".workboard-card__title", { hasText: card.title }).click();
        const detail = page.locator(".workboard-detail");
        await detail.getByText("Request changes", { exact: true }).click();
        await detail
          .getByRole("textbox", { name: "What should the worker change?" })
          .fill(instructions);
        await detail.screenshot({ path: path.join(suite.artifactDir, "request-changes.png") });
        await detail.getByRole("button", { name: "Start new attempt" }).click();
        await gateway.waitForRequest("workboard.cards.start");
        await detail.getByText("Request changes", { exact: true }).waitFor({ state: "detached" });
        expect(
          (await gateway.getRequests("workboard.cards.start")).map(({ params }) => params),
        ).toEqual([{ id: card.id, rework: { instructions, expectedUpdatedAt: card.updatedAt } }]);
        expect(await gateway.getRequests("workboard.cards.create")).toHaveLength(0);
      },
    );
  });
});
