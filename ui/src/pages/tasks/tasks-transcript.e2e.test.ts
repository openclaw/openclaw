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
  it.each([1440, 390])("returns to the task at %i px", async (width) => {
    const height = width === 1440 ? 900 : 844;
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width, height },
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
                response: {
                  messages: [{ role: "user", content: "Original automation request" }],
                },
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
      const openerBounds = await oldButton.boundingBox();
      assert.isNotNull(openerBounds);
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
      expect(headingBounds.y + headingBounds.height).toBeLessThanOrEqual(height);
      await transcript.getByRole("button", { name: "Show earlier" }).click();
      await transcript.getByText("Original automation request", { exact: true }).waitFor();
      expect(await oldRow.getByRole("link", { name: "Open session" }).count()).toBe(1);
      const close = transcript.getByRole("button", { name: "Close", exact: true });
      await close.focus();
      await close.press("Enter");
      await expect
        .poll(() => oldButton.evaluate((element) => document.activeElement === element))
        .toBe(true);
      const returnedBounds = await oldButton.boundingBox();
      assert.isNotNull(returnedBounds);
      expect(Math.abs(returnedBounds.y - openerBounds.y)).toBeLessThanOrEqual(1);
      await page.keyboard.press("Tab");
      expect(
        await oldRow
          .getByRole("link", { name: "Open session" })
          .evaluate((element) => document.activeElement === element),
      ).toBe(true);
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
        [oldTask.id, oldTask.id, oldTask.id, newTask.id].map((taskId) => ({
          params: { taskId },
        })),
      );
      await gateway.emitGatewayEvent("task", {
        action: "upserted",
        task: { ...newTask, status: "running", updatedAt: 7000 },
      });
      await page.locator(`[data-task-section="active"] [data-task-id="${newTask.id}"]`).waitFor();
      await gateway.emitGatewayEvent("task", {
        action: "upserted",
        task: { ...newTask, updatedAt: 8000 },
      });
      await page.locator(`[data-task-section="recent"] [data-task-id="${newTask.id}"]`).waitFor();
      await page.setViewportSize({ width, height: 500 });
      await close.focus();
      await close.press("Enter");
      const newButton = page
        .locator(`[data-task-id="${newTask.id}"]`)
        .getByRole("button", { name: "View transcript", exact: true });
      await expect
        .poll(() => newButton.evaluate((element) => document.activeElement === element))
        .toBe(true);
      const resizedBounds = await newButton.boundingBox();
      assert.isNotNull(resizedBounds);
      const focusInset = await newButton.evaluate((element) => {
        const style = getComputedStyle(element);
        return Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
      });
      expect(resizedBounds.y - focusInset).toBeGreaterThanOrEqual(-1);
      expect(resizedBounds.y + resizedBounds.height + focusInset).toBeLessThanOrEqual(501);
      await newButton.press("Enter");
      await transcript.getByText("Latest automation output", { exact: true }).waitFor();
      const socketCount = await gateway.getSocketCount();
      await gateway.closeLatest(1012, "Reconnect task transcript viewer");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await transcript.waitFor({ state: "detached" });
      await page
        .locator(`[data-task-id="${newTask.id}"]`)
        .getByRole("button", { name: "View transcript", exact: true })
        .click();
      await transcript.getByText("Latest automation output", { exact: true }).waitFor();
      // A new transcript selection in the same turn owns focus after Close commits.
      await close.evaluate((element) => {
        (element as HTMLButtonElement).click();
        document
          .querySelector<HTMLButtonElement>(
            '[data-task-id="old-automation-task"] .task-row__transcript',
          )!
          .click();
      });
      await transcript.getByText("Earlier automation output", { exact: true }).waitFor();
      await expect
        .poll(() => transcript.evaluate((element) => document.activeElement === element))
        .toBe(true);

      // Close must also respect focus that moves to another control before rendering.
      const refresh = page.getByRole("button", { name: "Refresh", exact: true });
      const refreshHandle = await refresh.elementHandle();
      assert.isNotNull(refreshHandle);
      await close.evaluate((element, nextFocus) => {
        (element as HTMLButtonElement).click();
        (nextFocus as HTMLButtonElement).focus();
      }, refreshHandle);
      await transcript.waitFor({ state: "detached" });
      expect(await refresh.evaluate((element) => document.activeElement === element)).toBe(true);
      await newButton.click();
      await transcript.getByText("Latest automation output", { exact: true }).waitFor();
      await refresh.focus();
      await gateway.emitGatewayEvent("task", { action: "deleted", taskId: newTask.id });
      await transcript.waitFor({ state: "detached" });
      expect(await refresh.evaluate((element) => document.activeElement === element)).toBe(true);
    } finally {
      await context.close();
    }
  });
});
