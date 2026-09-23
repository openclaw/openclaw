import { assert, expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Tasks retained transcripts",
  startServerBeforeBrowser: true,
});
const oldTask = {
  id: "old-automation-task",
  taskId: "old-automation-task",
  runtime: "cron",
  kind: "automation_run",
  status: "completed",
  title: "Earlier automation run",
  agentId: "main",
  hasTranscript: true,
  childSessionKey: "agent:main:cron:synthetic:run:old-generation",
  createdAt: 1000,
  updatedAt: 2000,
};
const newTask = {
  ...oldTask,
  id: "new-automation-task",
  taskId: "new-automation-task",
  title: "Latest automation run",
  childSessionKey: "agent:main:cron:synthetic:run:new-generation",
  createdAt: 3000,
  updatedAt: 4000,
};

suite.define(() => {
  it("opens the exact listed automation task, pages history, and retires closed reads", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1100, height: 900 },
    });
    const page = await context.newPage();
    try {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "tasks.list": {
            tasks: [
              oldTask,
              newTask,
              ...Array.from({ length: 24 }, (_, index) => ({
                ...newTask,
                id: `other-task-${index}`,
                taskId: `other-task-${index}`,
                title: `Other completed task ${index}`,
                createdAt: 5000 + index,
                updatedAt: 6000 + index,
              })),
            ],
          },
          "tasks.history": {
            cases: [
              {
                match: { taskId: oldTask.id, cursor: "older" },
                response: { messages: [{ role: "user", content: "Original automation request" }] },
              },
              {
                match: { taskId: oldTask.id },
                response: {
                  messages: [{ role: "assistant", content: "Earlier automation output" }],
                  nextCursor: "older",
                },
              },
              {
                match: { taskId: newTask.id },
                response: {
                  messages: [{ role: "assistant", content: "Latest automation output" }],
                },
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}tasks`);
      const oldRow = page.locator(`[data-task-id="${oldTask.id}"]`);
      await oldRow.waitFor({ state: "visible" });
      const oldButton = oldRow.getByRole("button", { name: "View transcript", exact: true });
      expect(await oldButton.count()).toBe(1);
      await oldButton.scrollIntoViewIfNeeded();
      await oldButton.focus();
      await oldButton.press("Enter");
      const transcript = page.getByRole("region", { name: "Task transcript", exact: true });
      await transcript.getByText("Earlier automation output", { exact: true }).waitFor();
      await expect
        .poll(() => transcript.evaluate((element) => element === document.activeElement))
        .toBe(true);
      const headingBounds = await transcript
        .getByRole("heading", { name: oldTask.title, exact: true })
        .boundingBox();
      assert.isNotNull(headingBounds);
      expect(headingBounds.y).toBeGreaterThanOrEqual(0);
      expect(headingBounds.y + headingBounds.height).toBeLessThanOrEqual(900);
      await transcript.getByRole("button", { name: "Show earlier" }).click();
      await transcript.getByText("Original automation request", { exact: true }).waitFor();
      expect(await oldRow.getByRole("link", { name: "Open session" }).count()).toBe(1);
      await transcript.getByRole("button", { name: "Close", exact: true }).click();
      expect(await oldButton.evaluate((element) => element === document.activeElement)).toBe(true);
      await gateway.deferNext("tasks.history", { taskId: oldTask.id, limit: 100 });
      await oldButton.click();
      await expect.poll(async () => (await gateway.getRequests("tasks.history")).length).toBe(3);
      await page
        .locator(`[data-task-id="${newTask.id}"]`)
        .getByRole("button", { name: "View transcript", exact: true })
        .click();
      await transcript.getByText("Latest automation output", { exact: true }).waitFor();
      await gateway.resolveDeferred("tasks.history", {
        messages: [{ role: "assistant", content: "Stale earlier response" }],
      });
      expect(await transcript.textContent()).not.toContain("Stale earlier response");
      expect(await transcript.textContent()).not.toContain("Earlier automation output");
      expect(await gateway.getRequests("tasks.history")).toMatchObject(
        [oldTask.id, oldTask.id, oldTask.id, newTask.id].map((taskId) => ({ params: { taskId } })),
      );
      const socketCount = await gateway.getSocketCount();
      await gateway.closeLatest(1012, "Reconnect task transcript viewer");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await transcript.waitFor({ state: "detached" });
      await page
        .locator(`[data-task-id="${newTask.id}"]`)
        .getByRole("button", { name: "View transcript", exact: true })
        .click();
      await transcript.getByText("Latest automation output", { exact: true }).waitFor();
      await gateway.emitGatewayEvent("task", { action: "deleted", taskId: newTask.id });
      await transcript.waitFor({ state: "detached" });
    } finally {
      await context.close();
    }
  });
});
