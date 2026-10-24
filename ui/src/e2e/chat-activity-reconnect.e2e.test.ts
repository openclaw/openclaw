import { expect } from "playwright/test";
import { it } from "vitest";
import { projectAgentToolActivity } from "../../../src/infra/agent-activity-events.js";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:activity-reconnect";
const runId = "activity-reconnect-run";
const commands = ["git status -sb", "git diff --stat"] as const;
const activity = (index: number, phase: "start" | "result") =>
  projectAgentToolActivity({
    toolCallId: `command-${index}`,
    name: "exec",
    phase,
    args: { command: commands[index] },
    ...(phase === "result" ? { isError: false } : {}),
  });
const user = {
  role: "user",
  content: "Check the working tree and report the result.",
  timestamp: 1,
  __openclaw: { id: "request", seq: 1 },
};
const durableMessages = [
  user,
  ...commands.flatMap((command, index) => [
    {
      role: "assistant",
      timestamp: index * 2 + 2,
      __openclaw: { id: `command-call-${index}`, seq: index * 2 + 2, runId },
      content: [{ type: "toolCall", id: `command-${index}`, name: "exec", arguments: { command } }],
    },
    {
      role: "toolResult",
      timestamp: index * 2 + 3,
      toolCallId: `command-${index}`,
      toolName: "exec",
      isError: false,
      content: "Working tree inspection complete.",
      __openclaw: { id: `command-result-${index}`, seq: index * 2 + 3, runId },
    },
  ]),
];

suite.define(() => {
  it.each([false, true])(
    "keeps prepared operation counts while reconnecting (new boot=%s)",
    async (reboot) => {
      await suite.withPage(
        {
          viewport: { height: 900, width: 1280 },
          reducedMotion: "reduce",
        },
        async ({ page }) => {
          const sessionInfo = {
            key: sessionKey,
            sessionId: "activity-reconnect-session",
            kind: "direct",
            status: "running",
            hasActiveRun: true,
            activeRunIds: [runId],
            lastRunId: runId,
          };
          const preparedHistory = prepareChatHistoryFixture(durableMessages);
          const initial = {
            sessionId: sessionInfo.sessionId,
            sessionInfo,
            messages: [user],
            inFlightRun: { runId, text: "", events: [] },
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            models: [{ id: "demo-model", name: "Demo model", provider: "demo" }],
            agentModel: "demo/demo-model",
            sessions: [sessionInfo],
            sessionInfo,
            methodResponses: { "chat.startup": initial, "chat.history": initial },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await waitForControlUiGatewayReady(page);
          await expect(page.getByText(user.content, { exact: true })).toBeVisible();
          const summary = page.locator(".chat-activity-group__summary");
          // These calls have reached the live stream but are not in the saved transcript yet.
          for (const index of [0, 1]) {
            await gateway.emitGatewayEvent("agent", {
              sessionKey,
              runId,
              seq: index * 3 + 1,
              ts: index * 3 + 1,
              stream: "tool",
              data: {
                phase: "start",
                name: "exec",
                toolCallId: `command-${index}`,
                args: { command: commands[index] },
              },
            });
            if (index === 0) {
              await gateway.emitGatewayEvent("agent", {
                sessionKey,
                runId,
                seq: 2,
                ts: 2,
                stream: "tool",
                data: {
                  phase: "result",
                  name: "exec",
                  toolCallId: "command-0",
                  isError: false,
                  result: "Working tree inspection complete.",
                },
              });
            }
            await gateway.emitGatewayEvent("agent", {
              sessionKey,
              runId,
              seq: index * 3 + 3,
              ts: index * 3 + 3,
              stream: "item",
              data: activity(index, index === 0 ? "result" : "start"),
            });
          }
          await expect(summary).toContainText(commands[1]);
          await gateway.setOnline(false);
          await waitForControlUiGatewayReconnecting(page);
          await expect(summary).toHaveText(/2 commands/);
          await expect(summary).not.toHaveText(/Raw details/);
          const recoveredSession = reboot
            ? sessionInfo
            : { ...sessionInfo, status: "done", hasActiveRun: false, activeRunIds: [] };
          const recovery = {
            sessionId: sessionInfo.sessionId,
            sessionInfo: recoveredSession,
            ...preparedHistory,
            ...(reboot
              ? {
                  inFlightRun: {
                    runId,
                    text: "",
                    events: [
                      {
                        sessionKey,
                        runId,
                        seq: 2,
                        ts: 9,
                        stream: "item",
                        data: activity(1, "result"),
                      },
                    ],
                  },
                }
              : {}),
          };
          await gateway.setMethodResponse("chat.startup", recovery);
          await gateway.setMethodResponse("chat.history", recovery);
          await gateway.setSessionsListResponse({ sessions: [recoveredSession] });
          const startupCount = (await gateway.getRequests("chat.startup")).length;
          if (reboot) {
            await gateway.setGatewayBootId("activity-reconnect-new-boot");
            await gateway.deferNext("chat.startup", { sessionKey });
          }
          await gateway.setOnline(true);
          await waitForControlUiGatewayReady(page);
          if (reboot) {
            await gateway.waitForRequest("chat.startup", { after: startupCount });
            await gateway.emitGatewayEvent("agent", {
              sessionKey,
              runId,
              seq: 1,
              ts: 8,
              stream: "item",
              data: activity(1, "start"),
            });
            await expect(summary).toContainText(commands[1]);
            await gateway.resolveDeferred("chat.startup", recovery);
          } else {
            await expect(summary).toHaveText(/2 commands/);
            await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();
          }
          await expect(summary).not.toHaveText(/Raw details/);
          await expect(summary).toHaveCount(1);
          await summary.click();
          await expect(page.locator(".chat-tool-row")).toHaveCount(2);
          await summary.click();
          await gateway.emitGatewayEvent("agent", {
            sessionKey,
            runId,
            seq: 1,
            ts: 1,
            stream: "item",
            data: activity(0, "start"),
          });
          await expect(summary).not.toHaveText(/Raw details/);
          await expect(summary).toHaveCount(1);
          if (!reboot) {
            // The terminal transcript now owns the same summary on another transport loss.
            await gateway.setOnline(false);
            await waitForControlUiGatewayReconnecting(page);
            await expect(summary).toHaveText(/2 commands/);
            await expect(summary).not.toHaveText(/Raw details/);
            await gateway.setOnline(true);
            await waitForControlUiGatewayReady(page);
            await expect(summary).toHaveText(/2 commands/);
            await expect(summary).not.toHaveText(/Raw details/);
            await summary.click();
            await expect(page.locator(".chat-tool-row")).toHaveCount(2);
            await summary.click();
            await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();
          }
        },
      );
    },
  );
});
