import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { exactButton } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI failed input ACK ownership" });

suite.define(() => {
  it.each(["adopted-a", "unadopted-c"])("%s survives a steer timeout", async (ownership) => {
    await suite.withPage({ viewport: { width: 1200, height: 800 } }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, { sessionKey });
      const chat = (payload: Record<string, unknown>) =>
        gateway.emitGatewayEvent("chat", { sessionKey, ...payload });
      const bubble = (text: string) =>
        page.locator(".chat-bubble").getByText(text, { exact: true });
      const toolText = "Successor C tool proof";
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.locator("[data-settings-send-shortcut]").selectOption("enter");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const composer = page.locator(".agent-chat__input textarea");
      await composer.fill("Start the original task.");
      await exactButton(page, "Send message").click();
      const original = await gateway.waitForRequest("chat.send");
      const runId = String(asOptionalRecord(original.params)?.idempotencyKey);
      const stop = page.getByRole("button", { name: "Stop generating" });
      await stop.waitFor();
      const progress = "Original run continues working.";
      await chat({
        runId,
        seq: 1,
        state: "delta",
        deltaText: progress,
        message: { role: "assistant", content: [{ type: "text", text: progress }] },
      });
      const reply = bubble(progress);
      await reply.waitFor();

      await gateway.deferNext("chat.send", { queueMode: "steer" });
      await composer.fill("Adjust the ongoing task.");
      await composer.press("Control+Enter");
      const steer = await gateway.waitForRequest("chat.send", { after: 1 });
      expect(steer.params).toMatchObject({ sessionKey, queueMode: "steer" });
      const steerRunId = String(asOptionalRecord(steer.params)?.idempotencyKey);
      expect(steerRunId).not.toBe(runId);
      await composer.fill("Keep this next message draft.");
      const successorTool = page.locator(".chat-tool-msg-summary").filter({ hasText: toolText });
      if (ownership === "unadopted-c") {
        await gateway.emitChatFinal({ runId, text: "Original task completed." });
        await bubble("Original task completed.").waitFor();
        const observerRun = "observer-tool-run";
        // C is another client's run: no local send or text delta adopts it here.
        await chat({ runId: observerRun, seq: 1, state: "status", phase: "starting_model" });
        await gateway.emitGatewayEvent("session.tool", {
          sessionKey,
          agentId: "main",
          runId: observerRun,
          seq: 2,
          ts: Date.now(),
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: "observer-tool-call",
            name: "exec",
            args: { command: `printf '${toolText}'` },
          },
        });
        await successorTool.waitFor();
        expect(await successorTool.count()).toBe(1);
        await successorTool.scrollIntoViewIfNeeded();
      }

      // Mirrors a targeted cancellation of the separate pre-ACK steer controller.
      const timeout = { runId: steerRunId, status: "timeout", stopReason: "rpc" };
      await gateway.resolveDeferred("chat.send", timeout);
      await page
        .getByTitle("The run ended before the message was accepted.", { exact: true })
        .waitFor();
      expect(await composer.inputValue()).toBe("Keep this next message draft.");

      if (ownership === "adopted-a") {
        expect(await reply.isVisible()).toBe(true);
        await chat({ runId, seq: 2, state: "delta", deltaText: " Still streaming." });
        await bubble(`${progress} Still streaming.`).waitFor();
        await composer.fill("");
        await stop.click();
        const aborted = await gateway.waitForRequest("chat.abort");
        expect(aborted.params).toEqual({ sessionKey, runId });
      } else {
        expect(await successorTool.isVisible()).toBe(true);
        expect(await successorTool.locator(".chat-tool-row__cmd").textContent()).toContain(
          toolText,
        );
      }
      expect(await gateway.getRequests("chat.send")).toHaveLength(2);
    });
  });
});
