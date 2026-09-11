// Execution's ownership harness must register after the broader dispatch mocks.
import "./dispatch-from-config.shared.test-harness.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readCurrentTurnReplyCompletion } from "../../agents/current-turn-reply-completion.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import {
  createMinimalRunAgentTurnParams,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createReplyOperationCompletionFixture } from "./reply-operation-completion.test-support.js";
import {
  recordReplyOperationAgentTurn,
  resolveReplyOperationRunState,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { buildTestCtx } from "./test-ctx.js";

const { emptyConfig, mocks } = await import("./dispatch-from-config.shared.test-harness.js");
const state = await setupAgentRunnerExecutionTestState();
const { executeAgentTurn } = await import("./agent-runner-execution.js");
const autoFallback = await import("./agent-runner-auto-fallback.js");
const { emitAgentEvent } = await import("../../infra/agent-events.js");

beforeAll(globalBeforeAll0);
beforeEach(() => {
  clearRuntimeConfigSnapshot();
  describe0BeforeEach0();
  setNoAbort();
});
afterEach(clearRuntimeConfigSnapshot);

describe("executeAgentTurn current-turn completion conversions", () => {
  it.each(
    (["confirmed", "ambiguous", "pending"] as const).flatMap((mode) =>
      (["cancelled", "role_ordering", "context_overflow", "settlement-rejected"] as const).map(
        (exit) => ({ mode, exit }),
      ),
    ),
  )("retains $mode authority through $exit without outer fallback", async ({ mode, exit }) => {
    const fixture = await createReplyOperationCompletionFixture(mode);
    const operation = createReplyOperation({
      sessionId: fixture.receipt.sessionId,
      sessionKey: "agent:main:completion-conversion",
      resetTriggered: false,
    });
    operation.setPhase("running");
    const params = createMinimalRunAgentTurnParams({
      replyOperation: operation,
      opts: { runId: fixture.receipt.runId },
    });
    params.followupRun.run.sessionId = fixture.receipt.sessionId;
    const embeddedError: EmbeddedAgentRunResult["meta"]["error"] =
      exit === "role_ordering" || exit === "context_overflow"
        ? { kind: exit, message: "original returned failure" }
        : undefined;
    const original: EmbeddedAgentRunResult = {
      payloads: [],
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: fixture.receipt.sessionId,
          provider: "anthropic",
          model: "claude",
          terminalReceipt: fixture.receipt,
        },
        ...(embeddedError ? { error: embeddedError } : {}),
      },
    };
    const snapshot = structuredClone(original);
    state.runEmbeddedAgentMock.mockResolvedValueOnce(original);
    state.isContextOverflowErrorMock.mockImplementation(
      (message) => exit === "context_overflow" && message === embeddedError?.message,
    );
    if (exit === "cancelled") {
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (candidate: FallbackRunnerParams) => {
          const result = await candidate.run(
            "anthropic",
            "claude",
            initialFallbackAttemptOptions(candidate),
          );
          expect(operation.abortByUser()).toBe(true);
          return { result, provider: "anthropic", model: "claude", attempts: [] };
        },
      );
    }
    const settlementError = new Error("original session override failure");
    const reconcile = vi.spyOn(autoFallback, "clearRecoveredAutoFallbackPrimaryProbeSelection");
    if (exit === "settlement-rejected") {
      reconcile.mockRejectedValueOnce(settlementError);
    }
    const runState: ReplyOperationRunState = {};
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({ deliver });
    const ledger = createReplyTurnLedger(dispatcher);
    try {
      // This is the real execution envelope, not a fixture copying private authority.
      const result = await executeAgentTurn(params).then(
        (execution) => ({ execution }),
        (error: unknown) => ({ error }),
      );
      let carrier: unknown;
      if ("error" in result) {
        expect(exit).toBe("settlement-rejected");
        expect(result.error).toBe(settlementError);
        carrier = result.error;
        recordReplyOperationAgentTurn([runState], operation, undefined, carrier);
      } else {
        expect(exit).not.toBe("settlement-rejected");
        expect(result.execution.outcome.kind).toBe(exit === "cancelled" ? "aborted" : "rejected");
        if (exit === "cancelled") {
          expect(result.execution.outcome).toEqual({ kind: "aborted", reason: "user" });
          expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
        } else {
          expect(operation.result).toMatchObject({ kind: "failed", cause: embeddedError });
          expect(operation.result && "cause" in operation.result && operation.result.cause).toBe(
            embeddedError,
          );
        }
        carrier = result.execution;
        recordReplyOperationAgentTurn([runState], operation, result.execution.outcome, carrier);
      }
      expect(readCurrentTurnReplyCompletion(carrier)).toBe(mode);
      expect(carrier).not.toHaveProperty("sourceReplyDelivered");
      ledger.recordCurrentTurnReplyCompletion(runState.currentTurnReplyCompletion);
      expect(ledger.canAttemptFallback()).toBe(false);
      expect(ledger.hasObservedDelivery()).toBe(mode === "confirmed");
      expect(ledger.hasPendingDelivery()).toBe(mode === "pending");
      const dispatched = await dispatchReplyFromConfig({
        ctx: buildTestCtx({ Provider: "telegram", Surface: "telegram" }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async (_ctx, options) => {
          recordReplyOperationAgentTurn(
            [expectDefined(resolveReplyOperationRunState(options), "reply operation run state")],
            operation,
            "execution" in result ? result.execution.outcome : undefined,
            carrier,
          );
          return undefined;
        },
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      expect(deliver).not.toHaveBeenCalled();
      expect(mocks.routeReply).not.toHaveBeenCalled();
      expect(dispatched.counts).toEqual({ tool: 0, block: 0, final: 0 });
      expect(dispatched.noVisibleReplyFallbackEligible).toBeUndefined();
      expect(dispatched.noVisibleReplyFallbackDelivered).toBeUndefined();
      expect(fixture.send).toHaveBeenCalledOnce();
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(state.runWithModelFallbackMock).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledTimes(exit === "cancelled" ? 0 : 1);
      expect(original).toEqual(snapshot);
      expect(original.meta.agentMeta?.terminalReceipt).toBe(fixture.receipt);
      expect(fixture.receipt.sourceReplyDelivered).toBe(mode === "confirmed" ? true : undefined);
      if (exit !== "settlement-rejected") {
        const terminal = expectDefined(
          vi
            .mocked(emitAgentEvent)
            .mock.calls.findLast(
              ([event]) =>
                event.runId === fixture.receipt.runId &&
                event.stream === "lifecycle" &&
                (event.data.phase === "end" || event.data.phase === "error"),
            ),
          "terminal lifecycle event call",
        )[0];
        expect(terminal.data.phase).toBe(exit === "cancelled" ? "end" : "error");
      }
      await fixture.settle();
      expect(readCurrentTurnReplyCompletion(carrier)).toBe(mode === "pending" ? "ambiguous" : mode);
      expect(ledger.canAttemptFallback()).toBe(false);
      expect(ledger.hasPendingDelivery()).toBe(false);
      recordReplyOperationAgentTurn([runState], undefined);
      ledger.recordCurrentTurnReplyCompletion(runState.currentTurnReplyCompletion);
      expect(ledger.canAttemptFallback()).toBe(true);
    } finally {
      reconcile.mockRestore();
      await fixture.settle();
      operation.complete();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }
  });
});
