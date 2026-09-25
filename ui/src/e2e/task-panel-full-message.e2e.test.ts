import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Task panel full-message recovery" });

suite.define(() => {
  it("recovers a capped subagent reply when opened from the Tasks rail", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:task-recovery";
      const childSessionKey = "agent:research:subagent:task-recovery";
      const messageId = "m-1";
      const preview = "Reply preview.\n...(truncated)...";
      const fullReply = "The complete reply includes the final result beyond the display cap.";
      const task = {
        id: "task-full-message",
        taskId: "task-full-message",
        runtime: "subagent",
        status: "running",
        agentId: "research",
        title: "Recover the complete task reply",
        sessionKey,
        ownerKey: sessionKey,
        childSessionKey,
        createdAt: 1,
        startedAt: 1,
        updatedAt: 2,
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: [{ role: "assistant", content: "The research task is running." }],
        methodResponses: {
          "tasks.list": { tasks: [task] },
          "tasks.get": { task },
          "tasks.history": {
            messages: [
              {
                role: "assistant",
                timestamp: 2,
                content: preview,
                __openclaw: { id: messageId, truncated: true, reason: "display-cap" },
              },
            ],
          },
          "chat.message.get": {
            ok: true,
            message: { role: "assistant", content: `**Complete result**\n\n${fullReply}` },
          },
        },
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await openChatSidePanelType(page, "Tasks");
      await page
        .locator('.chat-tasks-rail [data-task-id="task-full-message"]')
        .getByRole("button", { name: task.title, exact: true })
        .click();
      const panel = page.locator("[data-task-detail-panel]");
      await panel.getByText(fullReply, { exact: true }).waitFor();
      expect(await panel.locator("strong").textContent()).toBe("Complete result");
      expect(await panel.textContent()).not.toContain("Reply preview.");
      expect(await gateway.getRequests("tasks.history")).toEqual([
        expect.objectContaining({ params: expect.objectContaining({ taskId: task.id }) }),
      ]);
      expect(await gateway.getRequests("chat.message.get")).toEqual([
        expect.objectContaining({
          params: {
            sessionKey: childSessionKey,
            agentId: task.agentId,
            messageId,
            maxChars: 500_000,
          },
        }),
      ]);
    });
  });
});
