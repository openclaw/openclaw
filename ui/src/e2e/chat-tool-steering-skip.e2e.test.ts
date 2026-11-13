import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { projectAgentToolActivity } from "../../../src/infra/agent-activity-events.js";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Steering skip outcomes",
  startServerBeforeBrowser: true,
});
const completed = "Received the subagent update. The validation command needs attention.";
const ready = "Ready to prepare the release.";

suite.define(() => {
  it("distinguishes skipped calls from failures in live events and saved history", async () => {
    const context = await suite.browser.newContext({
      viewport: { width: 1200, height: 850 },
      colorScheme: "light",
    });
    try {
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        historyMessages: [{ role: "assistant", content: ready, timestamp: Date.now() }],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".chat-text").getByText(ready, { exact: true }).waitFor();
      await page.locator(".agent-chat__input textarea").fill("Prepare the release");
      await page.getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      const runId = asNullableRecord(send.params)?.idempotencyKey;
      assert.isString(runId);
      const timestamp = Date.now();
      const skipped = {
        role: "toolResult",
        toolCallId: "skipped-write",
        toolName: "write",
        content: [{ type: "text", text: "Skipped to process an incoming message." }],
        details: { status: "skipped", deniedReason: "steering" },
        isError: true,
        timestamp,
      };
      const args = { path: "/workspace/operation.json", content: '{"phase":"testing"}' };
      const emit = (seq: number, stream: string, data: unknown) =>
        gateway.emitGatewayEvent("agent", {
          runId,
          sessionKey: "main",
          seq,
          stream,
          ts: timestamp,
          data,
        });
      const tool = { name: "write", toolCallId: skipped.toolCallId };
      const result = { ...tool, phase: "result" as const, isError: true, result: skipped };
      await emit(1, "tool", { ...tool, phase: "start", args });
      await emit(2, "tool", result);
      await emit(3, "item", projectAgentToolActivity({ ...result, args }));
      const row = page.locator(".chat-tool-msg-summary").filter({ hasText: "operation.json" });
      await row.waitFor();
      await row.click({ position: { x: 4, y: 4 } });
      await page.locator(".chat-tool-card__outcome").waitFor();
      expect(await row.textContent()).not.toMatch(/blocked|failed/u);
      expect(await page.locator(".chat-tool-card__outcome").textContent()).toBe("Skipped");
      expect(await page.locator(".chat-tool-card--error").count()).toBe(0);
      expect(
        await page.getByRole("tab", { name: "Raw", exact: true }).getAttribute("aria-selected"),
      ).toBe("true");
      await row.click({ position: { x: 4, y: 4 } });
      expect(await row.textContent()).toContain("Skipped");

      const historyPage = await context.newPage();
      const call = { type: "toolCall", id: skipped.toolCallId, name: "write", arguments: args };
      await installMockGateway(historyPage, {
        methodResponses: {
          "chat.history": prepareChatHistoryFixture([
            { role: "user", content: "Prepare the release", timestamp: timestamp - 1_000 },
            { role: "assistant", content: [call], timestamp },
            skipped,
            {
              role: "toolResult",
              toolCallId: "failed-check",
              toolName: "exec",
              content: "Permission denied",
              isError: true,
              timestamp: timestamp + 1_000,
            },
            {
              role: "assistant",
              content: completed,
              timestamp: timestamp + 2_000,
            },
          ]),
        },
      });
      await historyPage.goto(`${suite.server.baseUrl}chat`);
      await historyPage.locator(".chat-text").getByText(completed, { exact: true }).waitFor();
      const group = historyPage.locator(".chat-activity-group__summary").first();
      // Completed work leaves failed and skipped steps to their rows.
      expect(await group.textContent()).not.toMatch(/failed|skipped|blocked/u);
      expect(await group.locator(".chat-activity-group__label").textContent()).not.toContain(
        "Write (failed)",
      );
      await group.click();
      const historyRow = historyPage
        .locator(".chat-tool-msg-summary")
        .filter({ hasText: "operation.json" });
      expect(await historyRow.textContent()).toContain("Skipped");
      await historyRow.click({ position: { x: 4, y: 4 } });
      expect(await historyPage.locator(".chat-tool-card__outcome").textContent()).toBe("Skipped");
      expect(await group.textContent()).not.toMatch(/failed|skipped|blocked/u);
    } finally {
      await context.close();
    }
  });
});
