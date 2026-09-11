import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentRunTerminalReceipt } from "../../agents/agent-run-terminal-receipt.js";
import {
  createCurrentTurnDeliveryTool,
  type CurrentTurnDelivery,
} from "../../agents/current-turn-delivery.js";
import {
  closeCurrentTurnReplyCompletionOwner,
  copyCurrentTurnReplyCompletion,
  createCurrentTurnReplyCompletionOwner,
} from "../../agents/current-turn-reply-completion.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";

type CompletionMode = "confirmed" | "ambiguous" | "pending" | "pre-dispatch" | "forged" | "spread";

export async function createReplyOperationCompletionFixture(mode: CompletionMode) {
  const owner = createCurrentTurnReplyCompletionOwner();
  const entered = createDeferred();
  const acknowledgement = createDeferred<Awaited<ReturnType<CurrentTurnDelivery["send"]>>>();
  const send = vi.fn<CurrentTurnDelivery["send"]>(
    async (_input, _bestEffort, _signal, onDispatch) => {
      if (mode === "pre-dispatch") {
        throw new PlatformMessageNotDispatchedError("rejected before dispatch", {
          cause: undefined,
        });
      }
      onDispatch?.();
      entered.resolve();
      return acknowledgement.promise;
    },
  );
  const settlement = createCurrentTurnDeliveryTool({ send }, owner).execute("source-send", {
    text: "source reply",
  });
  let receipt: AgentRunTerminalReceipt = {
    runId: "run-1",
    sessionId: "session-1",
    turnId: "run-1",
    requested: { provider: "openai", model: "gpt-5.4" },
    effective: { provider: "openai", model: "gpt-5.4", responseModel: "gpt-5.4" },
    successfulToolNames: ["read"],
    rerouted: false,
    terminalDisposition: "not-visible",
    ...(mode === "confirmed" ? { sourceReplyDelivered: true } : {}),
  };
  const settle = async () => {
    acknowledgement.resolve(
      mode === "confirmed"
        ? { status: "sent" }
        : { status: "partial_failed", sentBeforeError: true, error: "acknowledgement lost" },
    );
    await settlement;
  };
  if (mode === "pre-dispatch") {
    await settlement;
  } else {
    await entered.promise;
    if (mode !== "pending") {
      await settle();
    }
  }
  if (mode !== "forged") {
    copyCurrentTurnReplyCompletion(owner, receipt);
  }
  if (mode === "spread") {
    receipt = { ...receipt };
  }
  if (mode === "forged") {
    Object.assign(receipt, { sourceReplyDelivered: true, completion: "confirmed" });
  }
  // Retained receipts must keep pending acknowledgement updates after producer cleanup.
  closeCurrentTurnReplyCompletionOwner(owner);
  const execution = (kind: "settled" | "rejected" | "aborted"): AgentTurnExecutionResult => {
    if (kind === "settled") {
      return {
        runId: "run-1",
        outcome: {
          kind,
          status: "ok",
          result: {
            payloads: [],
            meta: {
              durationMs: 1,
              agentMeta: {
                sessionId: receipt.sessionId,
                provider: receipt.effective.provider,
                model: receipt.effective.model,
                terminalReceipt: receipt,
              },
            },
          },
          resolved: { provider: "openai", model: "gpt-5.4" },
          fallback: { exhausted: false, attempts: [] },
          autoCompactionCount: 0,
          didLogHeartbeatStrip: false,
        },
      };
    }
    return copyCurrentTurnReplyCompletion(receipt, {
      runId: "run-1",
      outcome:
        kind === "aborted"
          ? { kind, reason: "user" }
          : { kind, payload: { text: "genuine failure", isError: true } },
    });
  };
  return { receipt, send, settle, execution };
}
