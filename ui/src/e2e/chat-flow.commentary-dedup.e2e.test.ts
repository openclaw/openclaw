import path from "node:path";
import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps a commentary fallback distinct from the full row across a tool turn and reload", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const runId = "commentary-tool-reload-run";
      const commentary = "Searching for the answer…";
      const answer = "The answer is 42.";

      const userMessage = {
        role: "user",
        content: [{ type: "text", text: "Look it up for me." }],
        __openclaw: { id: "user", seq: 1, idempotencyKey: `${runId}:user` },
      };
      // The server history projection splits a mixed commentary/tool/answer turn
      // into two rows that share the owning transcript id: a keyed commentary
      // fallback and the full row (with the commentary stripped).
      const fallback = {
        role: "assistant",
        content: [{ type: "text", text: commentary }],
        __openclaw: { id: "assistant", seq: 2, runId },
        openclawStreamFallback: {
          itemId: "commentary-0",
          replacementText: commentary,
          source: "segment",
        },
      };
      const full = {
        role: "assistant",
        content: [{ type: "text", text: answer }],
        __openclaw: { id: "assistant", seq: 2, runId },
      };
      const toolEvent = {
        sessionKey: "agent:main:main",
        runId,
        seq: 1,
        ts: 1_001,
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "search-call",
          name: "web_search",
          result: { content: [{ type: "text", text: "Search result." }] },
        },
      };
      const historyMessages = [userMessage, fallback, full];
      const sessionInfo = { key: "agent:main:main", hasActiveRun: true, activeRunIds: [runId] };
      const inFlightRun = { runId, startedAt: 1_000, text: answer, events: [toolEvent] };

      const gateway = await installMockGateway(page, {
        historyMessages: [],
        inFlightRun: { ...inFlightRun, text: "" },
        sessionInfo,
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("button", { name: "Stop generating" }).waitFor();

      // Live tool turn: commentary item, tool result, then the answer delta.
      await gateway.emitGatewayEvent("agent", {
        sessionKey: "agent:main:main",
        runId,
        seq: 1,
        ts: 1_000,
        stream: "item",
        data: {
          kind: "preamble",
          itemId: "commentary-0",
          phase: "update",
          progressText: commentary,
        },
      });
      await gateway.emitGatewayEvent("agent", toolEvent);
      await gateway.emitGatewayEvent("chat", {
        sessionKey: "agent:main:main",
        runId,
        state: "delta",
        deltaText: answer,
        message: { role: "assistant", content: [{ type: "text", text: answer }] },
      });

      // Persist the fallback + full rows (sharing the transcript id).
      const session = {
        key: "main",
        kind: "direct",
        status: "running",
        updatedAt: Date.now(),
        hasActiveRun: true,
        activeRunIds: [runId],
      };
      for (const message of [fallback, full]) {
        await gateway.emitGatewayEvent("session.message", {
          sessionKey: "main",
          runId,
          clientRunId: runId,
          hasActiveRun: true,
          activeRunIds: [runId],
          messageId: "assistant",
          messageSeq: 2,
          session,
          message,
        });
      }

      const assistantTexts = async () =>
        (await page.locator(".chat-group.assistant .chat-text").allTextContents()).map((v) =>
          v.trim(),
        );
      await page.locator(".chat-group.assistant .chat-text", { hasText: commentary }).waitFor();
      expect((await assistantTexts()).filter((t) => t === commentary)).toHaveLength(1);
      expect(await assistantTexts()).toContain(answer);

      // Reload: the persisted history must still render the commentary once.
      const startupCount = (await gateway.getRequests("chat.startup")).length;
      await gateway.deferNext("chat.startup");
      await gateway.setOnline(false);
      await gateway.setOnline(true);
      await gateway.waitForRequest("chat.startup", { after: startupCount });
      await gateway.resolveDeferred("chat.startup", {
        messages: historyMessages,
        inFlightRun,
        sessionInfo,
        thinkingLevel: null,
      });
      await page.locator(".chat-group.assistant .chat-text", { hasText: commentary }).waitFor();
      expect((await assistantTexts()).filter((t) => t === commentary)).toHaveLength(1);
      expect(await assistantTexts()).toContain(answer);

      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(suite.artifactDir, "commentary-tool-reload.png"),
        });
      }
    });
  });
});
