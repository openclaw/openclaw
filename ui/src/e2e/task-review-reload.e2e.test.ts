import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Task Review reload" });
suite.define(() => {
  it("restores a selected completed task outside the recent list after browser reload", async () => {
    const proofDir = createControlUiE2eArtifactDir("task-review-reload");
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:task-reload";
      const result = "The retained task result is forty-two.";
      const task = {
        id: "reload-task",
        taskId: "reload-task",
        runtime: "subagent",
        status: "completed",
        title: "Verify the retained task",
        sessionKey,
        ownerKey: sessionKey,
        agentId: "main",
        childSessionKey: "agent:main:subagent:reload-task",
        createdAt: 1,
        updatedAt: 2,
        endedAt: 2,
        terminalSummary: result,
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: [{ role: "assistant", content: "Open the completed task." }],
        heldMethods: ["tasks.get"],
        methodResponses: {
          "tasks.list": { tasks: [] },
          "tasks.get": { task },
          "tasks.history": { messages: [{ role: "assistant", content: result }] },
        },
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await openChatSidePanelType(page, "Tasks");
        await gateway.waitForRequest("tasks.list");
        await gateway.emitGatewayEvent("task", { action: "upserted", task });
        await page.getByRole("button", { name: /Finished/ }).click();
        await page.locator('[data-task-id="reload-task"] .chat-tasks-rail__task-open').click();
        const panel = page.locator("[data-task-detail-panel]");
        await panel.getByText(result, { exact: true }).first().waitFor();
        await page.screenshot({ path: path.join(proofDir, "selected.png") });
        await page.reload();
        await gateway.waitForRequest("tasks.get");
        await page.locator('openclaw-panel-loading-skeleton[aria-busy="true"]').first().waitFor();
        expect(
          await page.getByText("This task is no longer available.", { exact: true }).count(),
        ).toBe(0);
        await gateway.resolveDeferred("tasks.get", { task });
        await panel.getByText(result, { exact: true }).first().waitFor();
        expect(await panel.locator(".sidebar-title").textContent()).toBe(task.title);
        expect(await page.locator("openclaw-session-diff").count()).toBe(0);
        await page.screenshot({ path: path.join(proofDir, "restored.png") });
      } catch (error) {
        await page.screenshot({ path: path.join(proofDir, "failure.png") });
        throw error;
      }
    });
  });
});
