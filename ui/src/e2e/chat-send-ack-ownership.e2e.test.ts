import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI failed input ACK ownership" });

suite.define(() => {
  it.each([
    {
      name: "keeps the active response and Stop target after a steer timeout ACK",
      ownership: "adopted-a",
    },
    {
      name: "keeps unadopted successor tool activity after a steer timeout ACK",
      ownership: "unadopted-c",
    },
  ] as const)("$name", async ({ ownership }) => {
    await suite.withPage({ viewport: { width: 1200, height: 800 } }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.locator("[data-settings-send-shortcut]").selectOption("enter");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const composer = page.locator(".agent-chat__input textarea");
      await composer.fill("Start the original task.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const original = await gateway.waitForRequest("chat.send");
      const runId = String(asOptionalRecord(original.params)?.idempotencyKey);
      const stop = page.getByRole("button", { name: "Stop generating" });
      await stop.waitFor();
      const progress = "Original run continues working.";
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        seq: 1,
        state: "delta",
        deltaText: progress,
        message: { role: "assistant", content: [{ type: "text", text: progress }] },
      });
      const reply = page.locator(".chat-bubble").getByText(progress, { exact: true });
      await reply.waitFor();

      await gateway.deferNext("chat.send", { queueMode: "steer" });
      await composer.fill("Adjust the ongoing task.");
      await composer.press("Control+Enter");
      const steer = await gateway.waitForRequest("chat.send", { after: 1 });
      expect(steer.params).toMatchObject({ sessionKey, queueMode: "steer" });
      const steerRunId = String(asOptionalRecord(steer.params)?.idempotencyKey);
      expect(steerRunId).not.toBe(runId);
      await composer.fill("Keep this next message draft.");
      const successorTool = page
        .locator(".chat-tool-msg-summary")
        .filter({ hasText: "Successor C tool proof" });
      const captureName = ownership === "adopted-a" ? "steer-timeout" : "unadopted-c-timeout";
      if (ownership === "unadopted-c") {
        await gateway.emitChatFinal({ runId, text: "Original task completed." });
        await page
          .locator(".chat-bubble")
          .getByText("Original task completed.", { exact: true })
          .waitFor();
        const successorRunId = "observer-tool-run";
        // C is another client's run: no local send or text delta adopts it here.
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId: successorRunId,
          seq: 1,
          state: "status",
          phase: "starting_model",
        });
        await gateway.emitGatewayEvent("session.tool", {
          sessionKey,
          agentId: "main",
          runId: successorRunId,
          seq: 2,
          ts: Date.now(),
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: "observer-tool-call",
            name: "exec",
            args: { command: "printf 'Successor C tool proof'" },
          },
        });
        await successorTool.waitFor();
        expect(await successorTool.count()).toBe(1);
        await successorTool.scrollIntoViewIfNeeded();
      }
      await page.screenshot({
        path: path.join(suite.artifactDir, `before-${captureName}.png`),
        fullPage: false,
      });

      // Mirrors a targeted cancellation of the separate pre-ACK steer controller.
      await gateway.resolveDeferred("chat.send", {
        runId: steerRunId,
        status: "timeout",
        stopReason: "rpc",
      });
      await page
        .getByTitle("The run ended before the message was accepted.", { exact: true })
        .waitFor();
      await page.screenshot({
        path: path.join(suite.artifactDir, `after-${captureName}.png`),
        fullPage: false,
      });
      expect(await composer.inputValue()).toBe("Keep this next message draft.");

      if (ownership === "adopted-a") {
        expect(await reply.isVisible()).toBe(true);
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          seq: 2,
          state: "delta",
          deltaText: " Still streaming.",
        });
        await page
          .locator(".chat-bubble")
          .getByText(`${progress} Still streaming.`, { exact: true })
          .waitFor();
        await composer.fill("");
        await stop.click();
        const aborted = await gateway.waitForRequest("chat.abort");
        expect(aborted.params).toEqual({ sessionKey, runId });
      } else {
        expect(await successorTool.isVisible()).toBe(true);
        expect(await successorTool.locator(".chat-tool-row__cmd").textContent()).toContain(
          "Successor C tool proof",
        );
      }
      expect(await gateway.getRequests("chat.send")).toHaveLength(2);
    });
  });
});
