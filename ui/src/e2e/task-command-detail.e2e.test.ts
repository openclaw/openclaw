import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Full command task detail",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:main";
const title = "Copy the captured review-panel screenshot into the task proof directory";
const command = [
  "cp .artifacts/control-ui-e2e/review-desktop/review-panel-collapsed.png",
  "  .openclaw/tmp/review-proof/review-panel-collapsed.png",
  "printf 'Captured the complete review panel\n'",
].join("\n");

suite.define(() => {
  it.each([
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ])(
    "keeps complete commands readable at $width px and settles completed work",
    async (viewport) => {
      const proofDir = createControlUiE2eArtifactDir(`task-command-detail-${viewport.width}`);
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          const startedAt = Date.now() - 5_000;
          const task = {
            id: "command-detail",
            taskId: "command-detail",
            runtime: "cli",
            kind: "exec",
            title,
            sessionKey,
            agentId: "main",
            ownerKey: sessionKey,
            status: "running",
            startedAt,
            createdAt: startedAt,
            updatedAt: startedAt,
            execution: { state: "running", lastActivityAt: startedAt },
          };
          const gateway = await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Inspect the background command." }],
              },
            ],
            methodResponses: {
              "tasks.list": { tasks: [task] },
              "tasks.get": { task: { ...task, prompt: command } },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("Inspect the background command.").waitFor();
          await openChatSidePanelType(page, "Tasks");
          await page.locator('[data-task-id="command-detail"] .chat-tasks-rail__task-open').click();
          const panel = page.locator("[data-task-detail-panel]");
          const prompt = panel.locator(".chat-tasks-rail__task-inspector-block pre").first();
          await expect.poll(() => prompt.textContent()).toBe(command);
          await writeFile(
            path.join(proofDir, "running.png"),
            await takeControlUiElementScreenshot(page, panel, [prompt]),
          );
          const heading = panel.locator(".sidebar-title");
          expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          expect(await prompt.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          expect(await panel.locator(".chat-task-detail__meta").textContent()).toContain("Running");
          const finished = {
            ...task,
            status: "completed",
            endedAt: Date.now(),
            updatedAt: Date.now(),
            execution: { state: "finished" },
            terminalSummary: "Command completed",
            deliveryStatus: "not_applicable",
          };
          await gateway.emitGatewayEvent("task", { action: "upserted", task: finished });
          await expect
            .poll(() => panel.locator(".chat-task-detail__meta").textContent())
            .toContain("Completed");
          expect(await panel.getByRole("button", { name: /^Stop / }).count()).toBe(0);
          expect(await prompt.textContent()).toBe(command);
          await writeFile(
            path.join(proofDir, "completed.png"),
            await takeControlUiElementScreenshot(page, panel, [prompt]),
          );
        },
      );
    },
  );
});
