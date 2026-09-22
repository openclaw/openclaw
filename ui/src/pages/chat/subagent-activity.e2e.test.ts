import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI compact subagent ordering",
  startServerBeforeBrowser: true,
});
const baseTime = Date.now();

suite.define(() => {
  it.each([1280, 390])(
    "keeps compact subagent rows stable until completion at %spx",
    async (width) => {
      const proofDir = createControlUiE2eArtifactDir(`subagent-stable-order-${width}`);
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 800 } },
        async ({ page }) => {
          const makeTask = (index: number, title: string) => ({
            runtime: "subagent",
            status: "running",
            agentId: "main",
            sessionKey: "agent:main:main",
            id: `stable-child-${index}`,
            taskId: `stable-child-${index}`,
            title,
            createdAt: baseTime - 10_000 + index * 1_000,
            updatedAt: baseTime - index * 1_000,
            lastActivity: "Inspecting the implementation",
          });
          const oldest = makeTask(0, "01 · Review session ownership");
          const middleTask = makeTask(1, "02 · Check tool rendering");
          const newest = makeTask(2, "03 · Verify mobile layout");
          const tasks = [oldest, middleTask, newest];
          const gateway = await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Three reviews are running in parallel." }],
              },
            ],
            methodResponses: { "tasks.list": { tasks } },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const activity = page.locator(".chat-subagent-activity");
          const rows = activity.locator("[data-subagent-task-id]");
          const order = () =>
            rows.evaluateAll((elements) =>
              elements.map((row) => row.getAttribute("data-subagent-task-id")),
            );
          const initialOrder = tasks.map((task) => task.id);
          await expect.poll(order).toEqual(initialOrder);
          await page.screenshot({
            path: path.join(proofDir, "01-created-order.png"),
            animations: "disabled",
          });
          const middle = activity.locator(`[data-subagent-task-id="${middleTask.id}"]`);
          await middle.focus();
          await page.keyboard.press("Escape");
          await expect.poll(() => activity.locator("wa-tooltip[open]").count()).toBe(0);
          const updated = {
            ...newest,
            updatedAt: baseTime + 1_000,
            lastActivity: "Mobile checks updated; row stays in place",
          };
          await gateway.emitGatewayEvent("task", { action: "upserted", task: updated });
          await rows.getByText(updated.lastActivity).waitFor();
          await page.screenshot({
            path: path.join(proofDir, "02-after-progress.png"),
            animations: "disabled",
          });
          expect(await order()).toEqual(initialOrder);
          expect(await middle.evaluate((element) => element === document.activeElement)).toBe(true);
          await gateway.emitGatewayEvent("task", {
            action: "upserted",
            task: {
              ...updated,
              status: "completed",
              updatedAt: baseTime + 2_000,
              endedAt: baseTime + 2_000,
              terminalSummary: "Mobile layout verified",
              deliveryStatus: "pending",
            },
          });
          await expect.poll(order).toEqual([oldest.id, middleTask.id]);
          expect(await activity.textContent()).not.toContain("Mobile layout verified");
          await page.keyboard.press("Escape");
          await page.screenshot({
            path: path.join(proofDir, "03-completed-child-removed.png"),
            animations: "disabled",
          });
          await gateway.emitGatewayEvent("task", {
            action: "upserted",
            task: {
              ...middleTask,
              status: "failed",
              endedAt: baseTime + 3_000,
              updatedAt: baseTime + 3_000,
              terminalSummary: "Tool rendering needs a fix",
            },
          });
          await gateway.emitGatewayEvent("task", {
            action: "upserted",
            task: {
              ...oldest,
              status: "timed_out",
              endedAt: baseTime + 4_000,
              updatedAt: baseTime + 4_000,
              terminalSummary: "Session review timed out",
            },
          });
          await activity.waitFor({ state: "detached" });
          await page.screenshot({
            path: path.join(proofDir, "04-no-ongoing-subagents.png"),
            animations: "disabled",
          });
        },
      );
    },
  );
});
