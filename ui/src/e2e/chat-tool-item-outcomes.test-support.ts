import type { Page } from "playwright";
import { expect, it } from "vitest";
import { projectAgentActivityItem } from "../../../src/agents/agent-activity-presentation.js";
import { projectInFlightRunSnapshot } from "../../../src/gateway/chat-inflight-snapshot.js";
import { createChatRunState } from "../../../src/gateway/server-chat-state.js";
import {
  projectAgentHistoryActivity,
  projectAgentToolActivity,
} from "../../../src/infra/agent-activity-events.js";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export function registerItemOnlyOutcomeTest(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  captureToolActivityProof: (page: Page, name: string) => Promise<void>,
) {
  it("retains running tools across reload and distinguishes incomplete history from outcomes", async () => {
    await suite.withPage(
      { colorScheme: "light", locale: "en-US", viewport: { height: 900, width: 1200 } },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        const gateway = await installMockGateway(page, { sessionKey });
        const prompt = "Verify the dependency update";
        const title = "Run reconciled build and compatibility gates";
        const toolCallId = "verify-build";
        const args = { title, code: "return await tools.exec({ command: 'pnpm build' });" };
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.locator(".agent-chat__input textarea").fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
        const runtime = createChatRunState();
        const emit = async (seq: number, stream: string, data: Record<string, unknown>) => {
          const event = { runId, sessionKey, seq, stream, ts: Date.now(), data };
          runtime.recordProgressEvent(runId, event);
          await gateway.emitGatewayEvent("agent", event);
        };
        await emit(
          1,
          "item",
          projectAgentToolActivity({
            toolCallId: "read-manifest",
            name: "read",
            args: { path: "package.json" },
            phase: "result",
            isError: false,
          }),
        );
        await emit(2, "tool", { toolCallId, name: "exec", args, phase: "start" });
        await emit(
          3,
          "item",
          projectAgentToolActivity({ toolCallId, name: "exec", args, phase: "start" }),
        );
        const summary = page.locator(".chat-activity-group__summary").first();
        const inspectRunning = async (stage: string) => {
          await summary.waitFor();
          await expect
            .poll(() => summary.locator(".chat-activity-group__label").textContent())
            .toBe(title + "…");
          expect(await summary.textContent()).not.toContain("unknown");
          await captureToolActivityProof(page, "lifecycle-" + stage);
        };
        await inspectRunning("live");
        const call = {
          role: "assistant",
          runId,
          content: [
            {
              type: "toolCall",
              id: "read-manifest",
              name: "read",
              arguments: { path: "package.json" },
            },
            { type: "toolCall", id: toolCallId, name: "exec", arguments: args },
          ],
          timestamp: 2,
        };
        const readResult = {
          role: "toolResult",
          toolCallId: "read-manifest",
          toolName: "read",
          runId,
          isError: false,
          content: [{ type: "text", text: "{}" }],
          timestamp: 3,
        };
        const activityMessages = [
          { messageId: "calls", message: call },
          { messageId: "manifest-result", message: readResult },
        ];
        const history = {
          messages: [
            { role: "user", content: prompt, timestamp: 1 },
            ...activityMessages.map(({ messageId, message }) => ({ ...message, messageId })),
          ],
          activity: projectAgentHistoryActivity(activityMessages),
          sessionId: "session:" + sessionKey,
          sessionInfo: {
            key: sessionKey,
            hasActiveRun: true,
            activeRunIds: [runId],
            status: "running",
          },
          inFlightRun: projectInFlightRunSnapshot({
            chatRunState: runtime,
            runId,
            startedAtMs: Date.now(),
          }),
        };
        await gateway.setMethodResponse("chat.history", history);
        await page.reload();
        await inspectRunning("restored");
        // Run liveness alone cannot establish which call is running when the
        // bounded replay omits its execution facts.
        await gateway.setMethodResponse("chat.history", {
          ...history,
          inFlightRun: { runId, text: "" },
        });
        await page.reload();
        await summary.waitFor();
        await captureToolActivityProof(page, "lifecycle-provisional");
        expect.soft(await summary.textContent()).not.toContain("unknown");
        await summary.click();
        const row = page
          .locator(".chat-activity-group__body .chat-tool-msg-summary")
          .filter({ hasText: title });
        await row.click();
        await page.locator(".chat-tool-card__outcome").last().waitFor();
        await captureToolActivityProof(page, "lifecycle-provisional-expanded");
        expect
          .soft(await page.locator(".chat-tool-card__outcome").last().textContent())
          .toBe("No result available.");
        expect(await page.locator(".chat-tool-row--running").count()).toBe(0);
        const result = {
          role: "toolResult",
          toolCallId,
          toolName: "exec",
          runId,
          isError: false,
          content: [{ type: "text", text: "Build passed" }],
          timestamp: 4,
        };
        await gateway.setMethodResponse("chat.history", {
          ...history,
          inFlightRun: undefined,
          sessionInfo: { key: sessionKey, hasActiveRun: false, activeRunIds: [], status: "done" },
          messages: [...history.messages, { ...result, messageId: "build-result" }],
          activity: projectAgentHistoryActivity([
            ...activityMessages,
            { messageId: "build-result", message: result },
          ]),
        });
        await page.reload();
        await summary.waitFor();
        expect(await summary.textContent()).not.toContain("unknown");
        await summary.click();
        await row.waitFor();
        expect(await row.textContent()).toContain(title);
      },
    );
  });

  it("preserves item-only outcomes in expanded live rows and after history reload", async () => {
    await suite.withPage(
      { colorScheme: "light", locale: "en-US", viewport: { height: 1400, width: 1200 } },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        const gateway = await installMockGateway(page, { sessionKey });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.locator(".agent-chat__input textarea").fill("Check the delegated tasks");
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
        const items = [
          { status: "failed", title: "Delegate task" },
          { status: "blocked", title: "Approval required" },
          { status: undefined, title: "Outcome unknown" },
        ].map(({ status, title }, index) =>
          projectAgentActivityItem({
            itemId: `operation-${index}`,
            toolCallId: `operation-${index}`,
            kind: "tool",
            name: "subagents",
            phase: "end",
            title,
            ...(status ? { status } : { summary: "Outcome unknown" }),
          }),
        );
        for (const [index, data] of items.entries()) {
          await gateway.emitGatewayEvent("agent", {
            runId,
            sessionKey,
            seq: index + 1,
            stream: "item",
            ts: Date.now(),
            data,
          });
        }
        const inspect = async (stage: string) => {
          const summary = page.locator(".chat-activity-group__summary").first();
          await summary.waitFor();
          await captureToolActivityProof(page, `item-outcomes-${stage}-collapsed`);
          expect.soft(await summary.textContent()).not.toContain("failed");
          await summary.click();
          const rows = page.locator(".chat-activity-group__body .chat-tool-msg-summary");
          await expect.poll(() => rows.count()).toBe(3);
          for (let index = 0; index < 3; index += 1) {
            await rows.nth(index).click();
          }
          await page.locator(".chat-tool-msg-body").last().waitFor();
          await captureToolActivityProof(page, `item-outcomes-${stage}-expanded`);
          expect
            .soft(await page.locator(".chat-tool-card__outcome").allTextContents())
            .toEqual(["failed", "Blocked", "Outcome unknown"]);
          expect.soft(await page.locator(".chat-tool-row--running").count()).toBe(0);
        };
        await inspect("live");
        const messages = items.map((item, index) => ({
          role: "assistant",
          messageId: `stored-${index}`,
          runId,
          content: [{ type: "toolCall", id: item.toolCallId, name: "subagents", arguments: {} }],
          timestamp: index + 1,
        }));
        await gateway.setMethodResponse("chat.history", {
          messages,
          activity: items.map((item, index) => ({ messageId: `stored-${index}`, items: [item] })),
          sessionId: `session:${sessionKey}`,
          sessionInfo: { key: sessionKey, hasActiveRun: false, activeRunIds: [], status: "done" },
        });
        await page.reload();
        await inspect("history");
      },
    );
  });
}
