/** A steer receipt must not consume the sequence of the run its rejected fallback starts. */
import { describe, expect, it, vi } from "vitest";
import {
  finalizeReplyMessageInjectionAttempt,
  type ReplyMessageInjectionAttempt,
  type ReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import {
  agentBroadcastCalls,
  chatBroadcastCalls,
  createAgentEventTestHarness,
} from "../server-chat.agent-events.test-harness.js";
import { emitAgentEvent, registerChatRun } from "../server-chat.agent-events.test-helpers.js";
import { finalizeAcceptedChatSendMessageInjection } from "./chat-send-message-injection.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock(import("../../sessions/session-controller.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  finalizeReplyMessageInjectionAttempt: vi.fn(),
}));

describe("rejected steer fallback", () => {
  it("starts the fallback run without a sequence gap after the receipt", async () => {
    const h = createAgentEventTestHarness();
    const sessionKey = "agent:main:dashboard:s";
    vi.mocked(finalizeReplyMessageInjectionAttempt).mockResolvedValue({
      status: "rejected",
      outcome: { status: "rejected", reason: "runtime_rejected" },
      targetRunId: "active",
    });
    const context = {
      agentRunSeq: h.agentRunSeq,
      broadcast: h.broadcast,
      nodeSendToSession: h.nodeSendToSession,
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestContext;
    const fallback = await finalizeAcceptedChatSendMessageInjection({
      attempt: { targetRunId: "active" } as unknown as ReplyMessageInjectionAttempt,
      context,
      ctx: { Provider: "dashboard", Body: "steer" },
      persistUserTurnTranscriptBestEffort: vi.fn(),
      session: { agentId: "main", cfg: {}, clientRunId: "run-1", sessionKey, storePath: "" },
      startedAt: 0,
      target: { runId: "active" } as unknown as ReplyMessageInjectionTarget,
    } as unknown as Parameters<typeof finalizeAcceptedChatSendMessageInjection>[0]);
    expect(fallback).toBe(false);
    expect(chatBroadcastCalls(h.broadcast).map(([, payload]) => payload)).toEqual([
      expect.objectContaining({ runId: "run-1", state: "input", delivery: "not-steered" }),
    ]);

    // chat.send registers its fallback run under the same client run ID.
    registerChatRun(h.chatRunState, "run-1", sessionKey, "run-1");
    await emitAgentEvent(h.handler, "run-1", "lifecycle", { phase: "start" }, { seq: 1 });
    await emitAgentEvent(h.handler, "run-1", "assistant", { text: "fallback" }, { seq: 2 });
    const gaps = agentBroadcastCalls(h.broadcast).filter(
      ([, payload]) => (payload as { stream?: string }).stream === "error",
    );
    expect(gaps).toEqual([]);
  });
});
