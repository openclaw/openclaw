import { expect, it } from "vitest";
import type { TaskSummary } from "../lib/tasks/task-summary.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Parent-first subagent inspection" });

suite.define(() => {
  it("keeps the parent draft while execution, waits, and result delivery advance", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const now = Date.now();
      const sessionKey = "agent:main:main";
      const task: TaskSummary = {
        id: "inspect-child",
        taskId: "inspect-child",
        status: "running",
        runtime: "subagent",
        sessionKey,
        ownerKey: sessionKey,
        agentId: "main",
        title: "Review release evidence",
        hasTranscript: true,
        startedAt: now - 60_000,
        updatedAt: now,
        lastToolName: "read",
        progressSummary: "Checking the platform results",
        execution: {
          state: "running",
          currentTool: { name: "exec", startedAt: now - 7_000 },
          lastActivityAt: now - 5_000,
        },
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: [{ role: "assistant", content: "I’ll combine the review results here." }],
        methodResponses: {
          "tasks.list": { tasks: [task] },
          "tasks.history": {
            activity: [
              { messageId: "poll", items: [] },
              {
                messageId: "failed",
                items: [
                  {
                    itemId: "tool:failed",
                    toolCallId: "failed",
                    kind: "tool",
                    phase: "end",
                    name: "exec",
                    title: "Validate samples",
                    status: "failed",
                  },
                ],
              },
            ],
            messages: [
              {
                role: "assistant",
                messageId: "poll",
                content: [
                  {
                    type: "toolCall",
                    id: "poll",
                    name: "process",
                    arguments: { action: "poll", sessionId: "samples" },
                  },
                ],
              },
              {
                role: "toolResult",
                toolCallId: "poll",
                content: [{ type: "text", text: "Still running" }],
              },
              {
                role: "assistant",
                messageId: "failed",
                content: [
                  {
                    type: "toolCall",
                    id: "failed",
                    name: "exec",
                    arguments: { command: "check-samples" },
                  },
                ],
              },
              {
                role: "toolResult",
                toolCallId: "failed",
                isError: false,
                content: [{ type: "text", text: "Missing title; exit 2" }],
              },
              {
                role: "assistant",
                messageId: "child-update",
                content: "The install evidence is ready.",
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Keep this parent follow-up");
      const parentUrl = page.url();
      const notice = page.locator('[data-subagent-task-id="inspect-child"]');
      await notice.click();
      const inspector = page.locator("[data-task-detail-panel]");
      await inspector.getByText("The install evidence is ready.").waitFor();
      const toolSummary = inspector.locator(".chat-task-feed__tool-group > summary");
      expect(await toolSummary.textContent()).toContain("1 operation");
      expect(await toolSummary.textContent()).toContain("1 failed");
      await toolSummary.click();
      expect(await inspector.locator(".chat-task-feed__calls").textContent()).toContain(
        "check-samples",
      );
      expect(await inspector.locator(".chat-task-feed__calls").textContent()).toContain("process");
      expect(await inspector.locator(".chat-task-detail__observation").textContent()).toContain(
        "Current tool",
      );
      expect(await inspector.locator(".chat-task-detail__observation code").textContent()).toBe(
        "exec",
      );
      expect((await gateway.getRequests("tasks.history")).at(-1)?.params).toEqual({
        taskId: task.id,
        limit: 100,
      });

      await gateway.emitGatewayEvent("task", {
        action: "upserted",
        task: {
          ...task,
          updatedAt: now + 1,
          execution: {
            state: "waiting",
            lastActivityAt: now,
            wait: {
              kind: "children",
              pendingCount: 2,
              dependencies: [
                { runId: "install", label: "Verify install evidence" },
                { runId: "update", label: "Verify update evidence" },
              ],
            },
          },
        },
      });
      await inspector.getByText("Waiting for children", { exact: true }).waitFor();
      await expect.poll(() => notice.getAttribute("aria-label")).toContain("Waiting for children");
      expect(await notice.locator(".chat-reading-indicator").count()).toBe(0);
      await inspector.getByText("2 children pending", { exact: true }).waitFor();
      expect(await inspector.getByText("Current tool", { exact: true }).count()).toBe(0);
      expect(await inspector.getByText("Last tool", { exact: true }).count()).toBe(1);
      expect(await inspector.getByText("Latest update", { exact: true }).count()).toBe(1);
      expect(await inspector.getByText("Verify update evidence", { exact: true }).count()).toBe(1);
      expect(await inspector.locator(".chat-tasks-rail__task-pulse").count()).toBe(0);

      await gateway.emitGatewayEvent("task", {
        action: "upserted",
        task: {
          ...task,
          updatedAt: now + 2,
          execution: {
            state: "waiting",
            wait: {
              kind: "children",
              pendingCount: 100,
              dependencies: Array.from({ length: 100 }, (_, index) => ({
                runId: `proof-${index}`,
                label: `Verify platform evidence ${index + 1}`,
              })),
            },
          },
        },
      });
      await inspector.getByText("100 children pending", { exact: true }).waitFor();
      expect(
        await inspector
          .locator(".chat-task-detail__observation")
          .evaluate((element) => element.scrollHeight > element.clientHeight),
      ).toBe(true);
      expect(
        await inspector
          .locator(".chat-task-detail__content")
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThan(200);

      await gateway.emitGatewayEvent("task", {
        action: "upserted",
        task: { ...task, updatedAt: now + 3, execution: { state: "finished" } },
      });
      await inspector.getByText("Execution finished", { exact: true }).waitFor();
      await notice.waitFor({ state: "detached" });
      expect(
        await inspector.getByRole("button", { name: "Stop Review release evidence" }).count(),
      ).toBe(1);
      expect(await inspector.locator(".chat-tasks-rail__task-pulse").count()).toBe(0);
      expect(await inspector.getByText("Result ready", { exact: true }).count()).toBe(0);
      expect(await inspector.getByText("Delivered to parent", { exact: true }).count()).toBe(0);

      const completed: TaskSummary = {
        ...task,
        status: "completed",
        updatedAt: now + 4,
        endedAt: now + 2,
        execution: { state: "finished", lastActivityAt: now + 2 },
        terminalSummary: "The release evidence is complete.",
        deliveryStatus: "session_queued",
      };
      await gateway.emitGatewayEvent("task", { action: "upserted", task: completed });
      await inspector.getByText("Queued for parent", { exact: true }).waitFor();
      expect(await notice.count()).toBe(0);
      expect(
        await inspector.getByRole("button", { name: "Stop Review release evidence" }).count(),
      ).toBe(0);
      expect(await inspector.getByText("Delivered to parent", { exact: true }).count()).toBe(0);

      // Delivery can settle in the same millisecond as execution. Its ordered
      // event must advance the selected detail without restoring inline activity.
      await gateway.emitGatewayEvent("task", {
        action: "upserted",
        task: { ...completed, deliveryStatus: "delivered" },
      });
      await inspector.getByText("Delivered to parent", { exact: true }).waitFor();
      expect(await notice.count()).toBe(0);
      expect(await inspector.getByText("Queued for parent", { exact: true }).count()).toBe(0);
      expect(
        await inspector.getByText("The release evidence is complete.", { exact: false }).count(),
      ).toBe(1);
      expect(page.url()).toBe(parentUrl);
      expect(await composer.inputValue()).toBe("Keep this parent follow-up");
      expect(await page.locator(".chat-main .chat-thread").textContent()).not.toContain(
        "The install evidence is ready.",
      );
    });
  });
});
