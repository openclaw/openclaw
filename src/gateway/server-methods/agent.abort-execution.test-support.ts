import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { isAgentRunDirectAbortReason } from "../../agents/run-termination.js";
import {
  getRpcSource,
  getRpcSourceProjectSessionActive,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  requireValue,
  expectRecordFields,
  mockCallArg,
  invokeAgent,
  prime,
} from "./agent.test-harness.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";

const mocks = getAgentTestMocks();
const sessionKey = "agent:main:main";
type Cancellation = { action: "chat.abort" | "/stop"; lateFailure?: boolean; staleKey?: boolean };

async function checkCancellation(
  { action, lateFailure, staleKey }: Cancellation,
  signal: AbortSignal,
) {
  prime();
  const finishRun = createDeferred();
  const context = makeContext();
  const runId = staleKey ? "idem-abort-stale-session-key" : "idem-abort-run";
  const client = staleKey ? { ...operatorWriteCliClient(), connId: "owner-conn" } : null;
  let acceptedEntry: RpcSourceRef | undefined;
  let capturedSignal: AbortSignal | undefined;
  mocks.agentCommand.mockImplementationOnce(async (opts: { abortSignal?: AbortSignal }) => {
    capturedSignal = opts.abortSignal;
    const entry = getRpcSource(runId);
    if (entry?.input.abortSignal === opts.abortSignal) {
      acceptedEntry = entry;
    }
    await finishRun.promise;
    if (lateFailure) {
      throw new Error("late provider failure");
    }
    return {
      payloads: [{ text: "late completion" }],
      meta: { durationMs: 1, terminalReply: { disposition: "visible", text: "late completion" } },
    };
  });
  let abort: Promise<void> | undefined;
  try {
    await invokeAgent(
      { message: "hi", agentId: "main", sessionKey, idempotencyKey: runId },
      { context, reqId: runId, client },
    );
    const active = requireValue(acceptedEntry, "active run missing");
    expect(getRpcSource(runId)).toBe(active);
    if (staleKey) {
      expect(active.input.target?.sessionKey).toBe(sessionKey);
    } else {
      expect(capturedSignal?.aborted).toBe(false);
    }
    const abortRespond = vi.fn();
    const options = { respond: abortRespond, context, client, isWebchatConnect: () => false };
    abort =
      action === "chat.abort"
        ? handleChatAbortRequest({
            ...options,
            params: { sessionKey: staleKey ? "agent:main:stale-key" : sessionKey, runId },
            req: { type: "req", id: "abort-req", method: "chat.abort" },
          })
        : handleDirectExternalChatSend({
            ...options,
            params: { sessionKey, message: "/stop", idempotencyKey: "idem-late-failure-stop" },
            req: { type: "req", id: "stop-req", method: "chat.send" },
          });
    // Cancellation must acknowledge while the raw producer is still blocked.
    await withinTest(abort, signal);
    expect(capturedSignal?.aborted).toBe(true);
    if (!staleKey) {
      expect(isAgentRunDirectAbortReason(capturedSignal?.reason)).toBe(true);
      expect(active.adapter.abortStopReason).toBe(action === "chat.abort" ? "rpc" : "stop");
    }
    expect(getRpcSourceProjectSessionActive(active)).toBe(false);
    expect(getRpcSource(runId)).toBe(active);
    expect(mockCallArg(abortRespond)).toBe(true);
    expectRecordFields(mockCallArg(abortRespond, 0, 1), { aborted: true, runIds: [runId] });
  } finally {
    finishRun.resolve();
    await Promise.allSettled([abort]);
    await acceptedEntry?.input.settlement.promise;
  }
  expect(getRpcSource(runId)).toBeUndefined();
  if (lateFailure) {
    const terminal = context.dedupe.get(`agent:${runId}`);
    expect(terminal?.ok).toBe(true);
    expect(terminal?.error).toBeUndefined();
    expectRecordFields(terminal?.payload, { runId, status: "timeout", summary: "aborted" });
  }
}

export function registerAgentAbortRunExecutionTest() {
  it.for([
    { action: "chat.abort", lateFailure: false },
    { action: "chat.abort", lateFailure: true },
    { action: "/stop", lateFailure: true },
  ] as const)("settles $action (late failure: $lateFailure)", (testCase, { signal }) =>
    checkCancellation(testCase, signal),
  );
}

export function registerAgentAbortStaleKeyExecutionTest() {
  it("chat.abort by runId allows the owner connection to use a stale session key", ({ signal }) =>
    checkCancellation({ action: "chat.abort", staleKey: true }, signal));
}
