import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFollowupTurnTestTypingController as createTypingController,
  createFollowupTurnTestTurn as createTurn,
  executeFollowupTurnForTest as executeFollowupTurn,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import { resolveReplyQueueAdmissionState } from "./queue-policy.js";
import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
  replyRunRegistry,
} from "./reply-run-registry.js";

const state = getFollowupTurnTestState();
beforeEach(resetFollowupTurnTestState);

describe("queued turn steering", () => {
  it("accepts same-authority steering while a queued turn runs and rejects changed authority", async () => {
    const operation = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      turnKind: "queued_followup",
      resetTriggered: false,
    });
    const turn = createTurn({ operation });
    const queueMessage = vi.fn(async () => {});
    state.execute.mockImplementation(async () => {
      operation.bindToolAuthorityRoute({ provider: "anthropic", model: "claude" });
      operation.attachBackend({ kind: "embedded", cancel: vi.fn(), queueMessage });
      expect(operation.phase).toBe("running");
      expect(
        resolveReplyQueueAdmissionState(
          { items: [turn.queued], inFlight: new Set([turn.queued]), droppedCount: 0 },
          operation,
        ),
      ).toBe("steering");
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget("main");
      expect(target).toBeDefined();
      const overlay = {
        originatingChannel: turn.queued.originatingChannel,
        messageProvider: turn.queued.run.messageProvider,
        senderId: "user-2",
        senderIsOwner: false,
        disableTools: false,
        traceAuthorized: false,
      };
      await expect(
        beginReplyMessageInjectionTarget(target!, "Use the revised request", {
          isInboundUserMessage: true,
          toolAuthorityOverlay: overlay,
        }).outcome,
      ).resolves.toMatchObject({ status: "accepted" });
      await expect(
        beginReplyMessageInjectionTarget(target!, "Change tool permissions", {
          isInboundUserMessage: true,
          toolAuthorityOverlay: { ...overlay, disableTools: true },
        }).outcome,
      ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
      expect(queueMessage).toHaveBeenCalledOnce();
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    try {
      await executeFollowupTurn({
        turn,
        defaults: { typing: createTypingController(), typingMode: "never", defaultModel: "claude" },
        onToolResult: vi.fn(async () => {}),
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
    } finally {
      operation.complete();
    }
  });
});
