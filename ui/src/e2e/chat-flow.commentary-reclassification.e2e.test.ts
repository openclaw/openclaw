import path from "node:path";
import { expect, it } from "vitest";
import { createSubscribedSessionHarness } from "../../../src/agents/embedded-agent-subscribe.e2e-harness.js";
import { projectInFlightRunSnapshot } from "../../../src/gateway/chat-abort.js";
import { projectAssistantCommentaryFallbacks } from "../../../src/gateway/chat-display-projection.commentary.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../../../src/gateway/server-chat-state.js";
import { createAgentEventHandler } from "../../../src/gateway/server-chat.js";
import type { AgentEventRuntimePayload } from "../../../src/infra/agent-events.js";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:main";
const commentary = [
  "I’ll inspect the workspace and trace the current request before making changes.",
  "The first check is complete. I’m checking the remaining files and their tests now.",
];

// The provider is synthetic; subscription, phase classification delivery, Gateway
// buffer/replay projection, and the browser all use their production owners.
function createProducer(runId: string) {
  const startedAt = Date.now() - 30_000;
  const frames: Array<{ event: string; payload: unknown }> = [];
  const chatRunState = createChatRunState();
  chatRunState.registry.add(runId, { clientRunId: runId, sessionKey });
  chatRunState.toolEventRecipients.add(runId, "browser");
  const handler = createAgentEventHandler({
    broadcast: (event, payload) => {
      frames.push({ event, payload });
    },
    broadcastToConnIds: (event, payload) => {
      frames.push({ event, payload });
    },
    nodeSendToSession: () => {},
    nodeHasSessionSubscribers: () => false,
    agentRunSeq: new Map(),
    chatRunState,
    resolveSessionKeyForRun: () => sessionKey,
    clearAgentRunContext: () => {},
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
  });
  let seq = 0;
  const { emit, subscription } = createSubscribedSessionHarness({
    runId,
    onAgentEvent: (event) => {
      const payload: AgentEventRuntimePayload = {
        ...event,
        runId,
        sessionKey,
        seq: ++seq,
        ts: Date.now(),
        projectSessionLifecycle: false,
        projectSessionMessages: false,
      };
      handler(payload);
    },
  });
  return {
    frames,
    startedAt,
    async message(
      text: string,
      itemId: string,
      phase?: "commentary" | "final_answer",
      latePhase = false,
    ) {
      const content = (phased: boolean) => [
        {
          type: "text",
          text,
          ...(phased && phase
            ? { textSignature: JSON.stringify({ v: 1, id: itemId, phase }) }
            : {}),
        },
      ];
      const message = {
        role: "assistant",
        timestamp: Date.now(),
        api: "openai-responses",
        content: content(!latePhase),
      };
      emit({ type: "message_start", message: { ...message, content: [] } });
      emit({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: text,
          partial: message,
        },
      });
      const completed = { ...message, content: content(true), stopReason: "stop" };
      emit({ type: "message_end", message: completed });
      await subscription.waitForPendingEvents();
      chatRunState.flushPendingText(runId);
      return completed;
    },
    tool(index: number) {
      for (const phase of ["start", "result"]) {
        const event: AgentEventRuntimePayload = {
          runId,
          sessionKey,
          seq: ++seq,
          ts: Date.now(),
          stream: "tool",
          projectSessionLifecycle: false,
          projectSessionMessages: false,
          data: {
            phase,
            name: "read",
            toolCallId: "read-" + index,
            args: { path: index ? "src/check.ts" : "README.md" },
            result: { content: [{ type: "text", text: "Workspace file checked." }] },
          },
        };
        handler(event);
        handler({
          ...event,
          seq: ++seq,
          stream: "item",
          data: {
            kind: "tool",
            itemId: "tool:read-" + index,
            toolCallId: "read-" + index,
            name: "read",
            title: index ? "Read source file" : "Read workspace guide",
            phase: phase === "start" ? "start" : "end",
            status: phase === "start" ? "running" : "completed",
          },
        });
      }
      chatRunState.flushPendingText(runId);
    },
    snapshot: () => projectInFlightRunSnapshot({ chatRunState, runId, startedAtMs: startedAt }),
    close() {
      subscription.unsubscribe();
      handler.dispose();
      chatRunState.clear();
    },
  };
}

suite.define(() => {
  it.each([
    { latePhase: true, terminal: "final" },
    { latePhase: false, terminal: "aborted" },
    { latePhase: true, terminal: "error" },
  ])(
    "keeps native commentary once through recovery and $terminal (late phase: $latePhase)",
    async ({ latePhase, terminal }) => {
      const runId = "native-commentary-run";
      const producer = createProducer(runId);
      try {
        await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
          const sessionInfo = { key: sessionKey, hasActiveRun: true, activeRunIds: [runId] };
          const historyMessages: unknown[] = [
            {
              role: "user",
              content: [
                { type: "text", text: "Inspect the workspace and run the focused checks." },
              ],
              __openclaw: { id: "request", seq: 1, idempotencyKey: runId + ":user" },
            },
          ];
          const gateway = await installMockGateway(page, {
            historyMessages,
            inFlightRun: { runId, startedAt: producer.startedAt, text: "" },
            sessionInfo,
          });
          await page.goto(suite.server.baseUrl + "chat");
          await page.getByRole("button", { name: "Stop generating" }).waitFor();
          for (const [index, text] of commentary.entries()) {
            const message = await producer.message(
              text,
              "commentary-" + index,
              "commentary",
              latePhase,
            );
            const saved = projectAssistantCommentaryFallbacks(
              { ...message, __openclaw: { id: "saved-" + index, seq: index + 2, runId } },
              10_000,
            ).fallbacks;
            historyMessages.push(...saved);
            producer.tool(index);
            for (const frame of producer.frames.splice(0)) {
              await gateway.emitGatewayEvent(frame.event, frame.payload);
            }
            for (const persisted of saved) {
              await gateway.emitGatewayEvent("session.message", {
                sessionKey,
                runId,
                hasActiveRun: true,
                activeRunIds: [runId],
                message: persisted,
              });
            }
          }
          const snapshot = producer.snapshot();
          const history = {
            messages: historyMessages,
            inFlightRun: snapshot,
            sessionInfo,
            thinkingLevel: null,
          };
          await gateway.setMethodResponse("chat.startup", history);
          await gateway.setMethodResponse("chat.history", history);
          const startupCount = (await gateway.getRequests("chat.startup")).length;
          await gateway.setOnline(false);
          await gateway.setOnline(true);
          await gateway.waitForRequest("chat.startup", { after: startupCount });
          await page.waitForFunction(() => {
            const pane = document.querySelector<HTMLElement & { state?: { chatLoading: boolean } }>(
              "openclaw-chat-pane",
            );
            return pane?.state?.chatLoading === false;
          });
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({
              fullPage: true,
              path: path.join(suite.artifactDir, "native-commentary-" + latePhase + ".png"),
            });
          }
          const texts = async () =>
            (await page.locator(".chat-group.assistant .chat-text").allTextContents()).map((text) =>
              text.trim(),
            );
          await expect.poll(texts).toEqual(commentary);
          expect(snapshot.text).toBe("");
          expect(await page.locator(".chat-tool-msg-summary").count()).toBe(2);
          if (terminal === "final") {
            await page.getByRole("link", { name: "Agents", exact: true }).click();
            await page.getByRole("region", { name: "Agents", exact: true }).waitFor();
            await page.goBack();
            await expect.poll(texts).toEqual(commentary);
            const answer = commentary.join("\n\n");
            await producer.message(answer, "final-answer", "final_answer");
            for (const frame of producer.frames.splice(0)) {
              await gateway.emitGatewayEvent(frame.event, frame.payload);
            }
            await expect
              .poll(async () => (await texts()).map((text) => text.replace(/\s+/gu, " ")))
              .toEqual([...commentary, commentary.join(" ")]);
          }
          await gateway.deferNext("chat.history");
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId,
            state: terminal,
            ...(terminal === "error" ? { errorMessage: "The fixture check was interrupted." } : {}),
          });
          await page.getByRole("button", { name: "Stop generating" }).waitFor({ state: "hidden" });
          await expect
            .poll(async () => (await texts()).map((text) => text.replace(/\s+/gu, " ")))
            .toEqual(terminal === "final" ? [...commentary, commentary.join(" ")] : commentary);
        });
      } finally {
        producer.close();
      }
    },
  );
});
