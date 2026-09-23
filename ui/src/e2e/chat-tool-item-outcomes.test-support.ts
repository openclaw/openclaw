import type { Page } from "playwright";
import { expect, it } from "vitest";
import { projectAgentActivityItem } from "../../../src/agents/agent-activity-presentation.js";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export function registerItemOnlyOutcomeTest(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  captureToolActivityProof: (page: Page, name: string) => Promise<void>,
) {
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
          expect.soft(await summary.textContent()).toContain("1 failed");
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
