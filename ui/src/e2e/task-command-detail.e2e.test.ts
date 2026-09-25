import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { focusChatSidePanel, openChatSidePanelType } from "./chat-side-panel.test-support.ts";
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
    "keeps commands readable, Back content-sized and usable, and completion visible at $width px",
    async (viewport) => {
      const proofDir = createControlUiE2eArtifactDir(`task-command-detail-${viewport.width}`);
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", colorScheme: "dark", viewport },
        async ({ page }) => {
          const now = new Date("2026-09-24T00:00:00Z");
          await page.clock.setFixedTime(now);
          const startedAt = now.getTime() - 5_000;
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
          if (viewport.width > 900) {
            await focusChatSidePanel(page);
          }
          await page.locator('[data-task-id="command-detail"] .chat-tasks-rail__task-open').click();
          const panel = page.locator("[data-task-detail-panel]");
          const prompt = panel.locator(".chat-tasks-rail__task-inspector-block pre").first();
          await expect.poll(() => prompt.textContent()).toBe(command);
          const back = panel.getByRole("button", { name: "Back to tasks", exact: true });
          await back.hover();
          await writeFile(
            path.join(proofDir, "running.png"),
            await takeControlUiElementScreenshot(page, panel, [prompt]),
          );
          const geometry = await back.evaluate((button) => {
            const box = button.getBoundingClientRect();
            const content = document.createRange();
            content.selectNodeContents(button);
            const style = getComputedStyle(button);
            const horizontalChrome = [
              style.paddingLeft,
              style.paddingRight,
              style.borderLeftWidth,
              style.borderRightWidth,
            ].reduce((sum, value) => sum + Number.parseFloat(value), 0);
            return {
              width: box.width,
              contentWidth: content.getBoundingClientRect().width + horizontalChrome,
              left: box.left,
              headingLeft: button.parentElement!.getBoundingClientRect().left,
            };
          });
          expect.soft(geometry.width).toBeCloseTo(geometry.contentWidth, 0);
          expect.soft(geometry.left).toBeCloseTo(geometry.headingLeft, 0);
          await back.click();
          await page.locator(".chat-tasks-rail").waitFor();
          await page.locator('[data-task-id="command-detail"] .chat-tasks-rail__task-open').click();
          await prompt.waitFor();
          const stop = panel.getByRole("button", { name: /^Stop / });
          await stop.focus();
          await page.keyboard.press("Shift+Tab");
          expect(await back.evaluate((button) => document.activeElement === button)).toBe(true);
          await page.keyboard.press("Enter");
          await page.locator(".chat-tasks-rail").waitFor();
          await page.locator('[data-task-id="command-detail"] .chat-tasks-rail__task-open').click();
          await prompt.waitFor();
          const heading = panel.locator(".sidebar-title");
          expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          expect(await prompt.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          expect(await panel.locator(".chat-task-detail__meta").textContent()).toContain("Running");
          const finished = {
            ...task,
            status: "completed",
            endedAt: now.getTime(),
            updatedAt: now.getTime(),
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
