import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Steering skip outcomes",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("distinguishes skipped calls from failures in live events and saved history", async () => {
    const artifactDir = createControlUiE2eArtifactDir("steering-skip");
    const context = await suite.browser.newContext({
      viewport: { width: 1200, height: 850 },
      colorScheme: "light",
    });
    try {
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        historyMessages: [
          { role: "assistant", content: "Ready to prepare the release.", timestamp: Date.now() },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Ready to prepare the release.").waitFor();
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
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey: "main",
        seq: 1,
        stream: "tool",
        ts: timestamp,
        data: { name: "write", toolCallId: skipped.toolCallId, phase: "start", args },
      });
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey: "main",
        seq: 2,
        stream: "tool",
        ts: timestamp,
        data: {
          name: "write",
          toolCallId: skipped.toolCallId,
          phase: "result",
          isError: true,
          result: skipped,
        },
      });
      const row = page.locator(".chat-tool-msg-summary").filter({ hasText: "operation.json" });
      await row.waitFor();
      await row.click({ position: { x: 4, y: 4 } });
      await page.locator(".chat-tool-card__outcome").waitFor();
      await page.locator(".chat-main").screenshot({ path: path.join(artifactDir, "live.png") });
      expect(await page.locator(".chat-tool-card__outcome").textContent()).toBe("Skipped");
      expect(await page.locator(".chat-tool-card--error").count()).toBe(0);
      expect(
        await page.getByRole("tab", { name: "Raw", exact: true }).getAttribute("aria-selected"),
      ).toBe("true");
      await row.click({ position: { x: 4, y: 4 } });
      expect(await row.textContent()).toContain("Skipped");

      const historyPage = await context.newPage();
      await installMockGateway(historyPage, {
        methodResponses: {
          "chat.history": prepareChatHistoryFixture([
            { role: "user", content: "Prepare the release", timestamp: timestamp - 1_000 },
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: skipped.toolCallId, name: "write", arguments: args },
              ],
              timestamp,
            },
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
              content: "Received the subagent update. The validation command needs attention.",
              timestamp: timestamp + 2_000,
            },
          ]),
        },
      });
      await historyPage.goto(`${suite.server.baseUrl}chat`);
      await historyPage
        .getByText("Received the subagent update. The validation command needs attention.")
        .waitFor();
      const group = historyPage.locator(".chat-activity-group__summary").first();
      expect(await group.textContent()).toContain("1 failed");
      expect(await group.textContent()).toContain("1 skipped");
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
      await historyPage
        .locator(".chat-main")
        .screenshot({ path: path.join(artifactDir, "history.png") });
    } finally {
      await context.close();
    }
  });
});
