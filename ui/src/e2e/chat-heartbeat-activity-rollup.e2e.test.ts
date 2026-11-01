import { expect, it } from "vitest";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI heartbeat activity rollup",
  startServerBeforeBrowser: true,
});

function heartbeatWake(index: number): Array<Record<string, unknown>> {
  const runId = `heartbeat-run-${index}`;
  const callId = `heartbeat-call-${index}`;
  const timestamp = 10_000 + index * 1_000;
  return [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: callId, name: "heartbeat_respond", arguments: { notify: false } },
      ],
      runId,
      timestamp,
    },
    {
      role: "toolResult",
      toolCallId: callId,
      toolName: "heartbeat_respond",
      content: "ok",
      isError: false,
      runId,
      timestamp: timestamp + 100,
    },
  ];
}

suite.define(() => {
  it("pools consecutive reply-less heartbeat wakes into one expandable rollup", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1200 } }, async ({ page }) => {
      const sessionKey = "agent:main:dashboard:heartbeat-rollup";
      const wakeCount = 6;
      await installMockGateway(page, {
        sessionKey,
        methodResponses: {
          "chat.history": prepareChatHistoryFixture([
            { role: "user", content: "Watch the queue.", timestamp: 1_000, runId: "reply-run" },
            chatMessage("assistant", "Watching.", { timestamp: 2_000, runId: "reply-run" }),
            ...Array.from({ length: wakeCount }, (_, index) => heartbeatWake(index + 1)).flat(),
          ]),
        },
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByText("Watching.", { exact: true }).waitFor();
      await waitForChatScrollIdle(page);

      const rollup = page.locator(".chat-group--activity .chat-activity-group__summary");
      await rollup.waitFor();
      await expect
        .poll(async () => rollup.locator(".chat-activity-group__label").textContent())
        .toBe(`${wakeCount} other operations`);
      expect(await rollup.count()).toBe(1);
      expect(await page.locator(".chat-tool-row").count()).toBe(0);

      await rollup.click();
      await expect
        .poll(async () => page.locator(".chat-activity-group__body .chat-tool-row").count())
        .toBe(wakeCount);
      await waitForChatScrollIdle(page);
    });
  });
});
