import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createNestedToolActivity } from "../../../src/sessions/nested-tool-activity.ts";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Media generation handoff" });
const prompt = "Make the poster more pixel-forward.";
const acknowledgment = "I’ll revise the poster with stronger square-pixel texture.";
const runId = "poster-run";
const timestamp = Date.UTC(2026, 10, 10, 9);
const identity = (id: string, seq: number) => ({ id, seq, runId });
const history = [
  {
    role: "user",
    content: prompt,
    timestamp,
    __openclaw: { ...identity("request", 1), idempotencyKey: runId + ":user" },
  },
  {
    role: "assistant",
    stopReason: "toolUse",
    timestamp: timestamp + 1_000,
    content: [
      { type: "text", text: acknowledgment },
      {
        type: "toolCall",
        id: "exec",
        name: "exec",
        arguments: {
          title: "Generate pixel poster",
          code: "await image_generate({prompt: 'Pixel poster'});",
        },
      },
    ],
    __openclaw: identity("call", 2),
  },
  {
    ...createNestedToolActivity({
      runId,
      scopeId: "scope",
      afterEntryId: "call",
      startOrder: 0,
      parentToolCallId: "exec",
      toolCallId: "image",
      toolName: "image_generate",
      input: { prompt: "Pixel poster" },
      result: {
        content: [{ type: "text", text: "Background image generation started." }],
        details: {
          async: true,
          status: "started",
          taskId: "image-task",
          runId: "image-task",
          task: { taskId: "image-task", runId: "image-task" },
        },
      },
      isError: false,
      startedAt: timestamp + 1_100,
      timestamp: timestamp + 1_200,
    }),
    __openclaw: identity("nested", 3),
  },
  {
    role: "toolResult",
    toolName: "exec",
    toolCallId: "exec",
    content: [{ type: "text", text: "Image generation accepted." }],
    timestamp: timestamp + 1_300,
    __openclaw: identity("result", 4),
  },
];

suite.define(() => {
  it("does not call an accepted background generation interrupted, including after reload", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 700 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        assistantName: "Roboclaw",
        methodResponses: { "chat.history": prepareChatHistoryFixture(history) },
      });
      await page.goto(suite.server.baseUrl + "chat");
      await gateway.waitForRequest("sessions.messages.subscribe");
      const thread = page.locator(".chat-thread");
      const request = thread.getByText(prompt, { exact: true });
      const reply = thread.getByText(acknowledgment, { exact: true });
      await request.waitFor();
      await reply.waitFor();
      const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR;
      if (parent) {
        const frame = await takeControlUiScreenshotFrame(page, thread, [request, reply], {
          animations: "disabled",
        });
        const dir = createControlUiE2eArtifactDir("media-handoff", parent);
        await writeFile(path.join(dir, "media-handoff.png"), frame.png);
        console.log("Screenshot: " + dir + "/media-handoff.png");
      }
      expect(await thread.getByText("Interrupted", { exact: true }).count()).toBe(0);
      await page.reload();
      await reply.waitFor();
      expect(await thread.getByText("Interrupted", { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
