import { expect, it } from "vitest";
import { projectAgentToolActivity } from "../../../src/infra/agent-activity-events.js";
import {
  createChatFlowE2eSuite,
  chatMessage,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { recordedToolCall } from "./recorded-tool.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("renders recorded and live execution purposes without requesting generated titles", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const command = "set -euo pipefail\npnpm test";
        const parentArgs = {
          code: "await tools.read({ path: 'README.md' })",
          title: "Inspect the workspace guide",
        };
        const childArgs = { command: "printf '\n--- workspace ---\n'\nls" };
        const gateway = await installMockGateway(page, {
          historyMessages: [
            recordedToolCall("history-check", "exec", { command, title: "Check the test suite" }),
            chatMessage("toolResult", "All tests passed.", {
              toolCallId: "history-check",
              toolName: "exec",
            }),
            chatMessage("assistant", "The checks are complete."),
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const historyRow = page.locator(".chat-tool-row", { hasText: "Check the test suite" });
        await historyRow.waitFor();
        await historyRow.click();
        await page.locator(".chat-tool-msg-body", { hasText: "All tests passed." }).waitFor();
        expect(await page.locator(".chat-tool-msg-body").textContent()).toContain(command);

        await page.locator(".agent-chat__composer-combobox textarea").fill("Check the workspace");
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const params = requireRecord(send.params);
        const runId = requireString(params.idempotencyKey, "chat run id");
        const sessionKey = requireString(params.sessionKey, "chat session key");
        let seq = 0;
        const emit = (stream: "item" | "tool", data: unknown) =>
          gateway.emitGatewayEvent("agent", {
            runId,
            sessionKey,
            seq: ++seq,
            ts: Date.now(),
            stream,
            data,
          });
        const parent = {
          phase: "start",
          toolCallId: "live-check",
          name: "exec",
          args: parentArgs,
        } as const;
        const child = {
          phase: "start",
          toolCallId: "live-child",
          name: "exec",
          args: childArgs,
        } as const;
        await emit("item", projectAgentToolActivity(parent));
        await emit("tool", parent);
        await page
          .locator(".chat-tool-row--running .chat-tool-row__title", {
            hasText: "Inspect the workspace guide",
          })
          .waitFor();
        await emit("item", projectAgentToolActivity(child));
        await emit("tool", { ...child, parentToolCallId: "live-check" });
        const activity = page.locator(".chat-activity-group", {
          hasText: "Inspect the workspace guide",
        });
        const summary = activity.locator(":scope > .chat-activity-group__summary");
        await summary.waitFor();
        expect(await summary.textContent()).toContain("Inspect the workspace guide");
        expect(await summary.textContent()).not.toContain("printf");
        await summary.click();
        const operation = activity.locator(".chat-tool-row", {
          hasText: "Inspect the workspace guide",
        });
        expect(await activity.locator(".chat-tool-row").count()).toBe(1);
        await operation.click();
        await activity.locator(".chat-tool-children .chat-tool-row--running").waitFor();
        await emit("tool", {
          phase: "result",
          toolCallId: "live-child",
          parentToolCallId: "live-check",
          name: "exec",
          result: { content: [{ type: "text", text: "README.md" }] },
        });
        await emit("item", projectAgentToolActivity({ ...child, phase: "result", isError: false }));
        await expect
          .poll(() => activity.locator(".chat-tool-children .chat-tool-row--running").count())
          .toBe(0);
        expect(await operation.getAttribute("aria-expanded")).toBe("true");
        expect(await gateway.getRequests("chat.toolTitles")).toHaveLength(0);
      },
    );
  });
});
