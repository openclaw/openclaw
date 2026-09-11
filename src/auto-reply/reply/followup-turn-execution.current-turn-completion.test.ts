import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyCurrentTurnReplyCompletion,
  readCurrentTurnReplyCompletion,
} from "../../agents/current-turn-reply-completion.js";
import {
  createFollowupTurnTestTypingController,
  createFollowupTurnTestTurn,
  executeFollowupTurnForTest,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import { createReplyOperationCompletionFixture } from "./reply-operation-completion.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation, markReplyOperationExecutionStarted } from "./reply-run-registry.js";

const state = getFollowupTurnTestState();

beforeEach(resetFollowupTurnTestState);

describe.each(["confirmed", "ambiguous", "pending"] as const)(
  "executeFollowupTurn with %s current-turn receipt",
  (mode) => {
    it.each(["settled", "rejected", "aborted", "throw"] as const)(
      "retains the queued %s receipt on the exact source operation",
      async (kind) => {
        const fixture = await createReplyOperationCompletionFixture(mode);
        const operation = createReplyOperation({
          sessionId: "session-1",
          sessionKey: "main",
          resetTriggered: false,
        });
        operation.setPhase("running");
        const receipts: ReplyOperationRunState[] = [{}, {}];
        const newerReceipt: ReplyOperationRunState = {};
        const turn = createFollowupTurnTestTurn({ operation });
        turn.queued.replyOperationRunStates = receipts;
        const originalError = copyCurrentTurnReplyCompletion(
          fixture.receipt,
          new Error("native execution disconnected"),
        );
        const execution = kind === "throw" ? undefined : fixture.execution(kind);
        const originalExecution = structuredClone(execution);
        state.execute.mockImplementation(async () => {
          markReplyOperationExecutionStarted(operation);
          if (kind === "throw") {
            throw originalError;
          }
          return execution;
        });
        try {
          const result = await executeFollowupTurnForTest({
            turn,
            defaults: {
              typing: createFollowupTurnTestTypingController(),
              typingMode: "never",
              defaultModel: "claude",
              opts: { [REPLY_OPERATION_RUN_STATE]: newerReceipt },
            },
            onToolResult: vi.fn(async () => {}),
            onCompactionNoticePayload: vi.fn(async () => {}),
          });
          await result.progress.drain();
          for (const receipt of receipts) {
            expect(receipt.agentTurnOwner).toBe(operation);
            expect(readCurrentTurnReplyCompletion(receipt.currentTurnReplyCompletion)).toBe(mode);
          }
          expect(newerReceipt.currentTurnReplyCompletion).toBeUndefined();
          expect(execution).toEqual(originalExecution);
          expect(fixture.receipt.successfulToolNames).toEqual(["read"]);
          if (kind === "throw") {
            expect(operation.result).toEqual({
              kind: "failed",
              code: "run_failed",
              cause: originalError,
            });
          } else {
            expect(result.execution).toBe(execution);
          }
        } finally {
          await fixture.settle();
          operation.complete();
        }
      },
    );
  },
);
