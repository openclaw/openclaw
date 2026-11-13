import { expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { inlineActivityDisclosureCalls } from "./chat-activity-segments.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { agentEvent } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

it.each(["quiet", "newer output", "terminal"] as const)(
  "recovers stdout after admission while preserving %s during the read",
  async (duringRead) => {
    const key = "main";
    const runId = "output-recovery-run";
    const admission = createDeferred<{ key: string }>();
    const requested = createDeferred();
    const snapshot = createDeferred<ChatHistoryResult>();
    const start = agentEvent(runId, 1, "tool", {
      toolCallId: "call",
      name: "exec",
      phase: "start",
      args: { command: "quiet-command" },
    });
    const progress = (seq: number, text: string) =>
      agentEvent(runId, seq, "tool", {
        toolCallId: "call",
        name: "exec",
        phase: "update",
        outputOnly: true,
        partialResult: text,
      });
    const state = makeChatHost({
      sessionKey: key,
      currentSessionId: "output-recovery-session",
      chatRunId: runId,
      settings: { chatInlineCommands: false },
      requestHandlers: {
        "sessions.messages.subscribe": (params: { includeLiveToolOutput?: boolean }) =>
          params.includeLiveToolOutput ? admission.promise : { key },
        "chat.history": () => {
          requested.resolve();
          return snapshot.promise;
        },
      },
    });
    onTestFinished(() => state.sessions.dispose());
    await expect(syncSelectedSessionMessageSubscription(state)).resolves.toBe(true);
    handleAgentEvent(state, start);
    state.settings.chatInlineCommands = true;
    state.inlineCommandPresentation = { inlineActivityDisclosureCalls };
    const ready = syncSelectedSessionMessageSubscription(state);
    await expect
      .poll(() => requestCalls(state.request, "sessions.messages.subscribe").length)
      .toBe(2);
    expect(requestCalls(state.request, "chat.history")).toHaveLength(0);
    admission.resolve({ key });
    await expect(ready).resolves.toBe(true);
    await requested.promise;
    if (duringRead === "newer output") {
      handleAgentEvent(state, progress(3, "Newer live stdout"));
    } else if (duringRead === "terminal") {
      handleChatGatewayEvent(state, { sessionKey: key, runId, seq: 4, state: "aborted" });
    }
    snapshot.resolve({
      sessionId: "output-recovery-session",
      messages: [],
      sessionInfo: {
        key,
        kind: "direct",
        sessionId: "output-recovery-session",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: [runId],
        status: "running",
      },
      inFlightRun: { runId, text: "", events: [start, progress(2, "Quiet recovered stdout")] },
    });
    await expect.poll(() => getChatHistoryLoadState(state).phase).toBe("committed");
    if (duringRead === "terminal") {
      expect(state.chatRunId).toBeNull();
      expect(JSON.stringify(state.chatToolMessages)).not.toContain("Quiet recovered stdout");
    } else {
      await expect
        .poll(() => JSON.stringify(state.chatToolMessages))
        .toContain(duringRead === "quiet" ? "Quiet recovered stdout" : "Newer live stdout");
      expect(state.chatRunId).toBe(runId);
    }
  },
);
