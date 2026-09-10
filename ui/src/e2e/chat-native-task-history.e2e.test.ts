import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

let browser: Browser;
let server: ControlUiE2eServer;
describe("native task inspection", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("reads a child in the rail and refreshes after parent yield without parent events", async () => {
    const artifacts = createControlUiE2eArtifactDir("native-task-history");
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    try {
      const task = {
        id: "native-inspection-task",
        taskId: "native-inspection-task",
        kind: "codex-native",
        runtime: "subagent",
        status: "running",
        title: "Inspect native child",
        agentId: "main",
        sessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now(),
        startedAt: Date.now() - 60_000,
        prompt: "Inspect the parser and report progress.",
        result: "Child is running.",
      };
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Parent is waiting for its child." }],
          },
        ],
        methodResponses: { "tasks.list": { tasks: [task] }, "tasks.get": { task } },
      });
      await page.goto(`${server.baseUrl}chat`);
      await page.locator('button[data-subagent-task-id="native-inspection-task"]').click();
      const panel = page.locator("[data-task-detail-panel]");
      await panel.getByText(task.prompt, { exact: true }).waitFor();
      await page.screenshot({ path: path.join(artifacts, "before-inspector.png") });

      const nativeTask = { ...task, transcriptAvailable: true, updatedAt: task.updatedAt + 1 };
      await gateway.setMethodResponse("tasks.get", { task: nativeTask });
      await gateway.setMethodResponse("tasks.history", {
        taskId: task.id,
        items: [{ id: "call", type: "toolCall", text: "Read parser.ts" }],
        nextCursor: "older",
      });
      await gateway.emitGatewayEvent("task", { action: "upserted", task: nativeTask });
      await panel.getByText("Read parser.ts", { exact: false }).waitFor();
      expect(await panel.textContent()).not.toContain("Parent is waiting");
      await gateway.setMethodResponse("tasks.history", {
        taskId: task.id,
        items: [
          { id: "result", type: "toolResult", text: "Parser checks passed." },
          { id: "call", type: "toolCall", text: "Read parser.ts" },
        ],
        nextCursor: "older",
      });
      // No parent run, chat event or task event drives this second read.
      await panel.getByText("Parser checks passed.", { exact: false }).waitFor();
      await panel.getByRole("button", { name: "Load older" }).waitFor();
      await page.screenshot({ path: path.join(artifacts, "after-native-transcript.png") });
      await gateway.setMethodResponse("tasks.get", {
        task: { ...nativeTask, status: "completed", updatedAt: nativeTask.updatedAt + 1 },
      });
      await panel
        .locator(".chat-tasks-rail__task-status")
        .getByText("Completed", { exact: true })
        .waitFor();
      const historyRequests = await gateway.getRequests("tasks.history");
      expect(historyRequests.length).toBeGreaterThanOrEqual(2);
      for (const request of historyRequests) {
        expect(request.params).toMatchObject({ taskId: task.id });
        expect(request.params).not.toHaveProperty("threadId");
      }
      for (const request of await gateway.getRequests("chat.history")) {
        expect(request.params).toMatchObject({ sessionKey: task.sessionKey });
      }
    } finally {
      await context.close();
    }
  });
});
