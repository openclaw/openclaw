import { assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GetReplyOptions } from "../types.js";
import {
  createMinimalRunAgentTurnParams,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  runInitialFallbackAttempt,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

beforeEach(async () => {
  state.isCliProviderMock.mockReturnValue(true);
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
    result: await runInitialFallbackAttempt(params, "claude-cli", "claude-opus-4-6"),
    provider: "claude-cli",
    model: "claude-opus-4-6",
    attempts: [],
  }));
  const { createBlockReplyDeliveryHandler } =
    await vi.importActual<typeof import("./reply-delivery.js")>("./reply-delivery.js");
  state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(createBlockReplyDeliveryHandler);
});

function createCliTurn(opts: GetReplyOptions) {
  const followupRun = createFollowupRun();
  followupRun.run.provider = "claude-cli";
  followupRun.run.model = "claude-opus-4-6";
  return createMinimalRunAgentTurnParams({
    followupRun,
    sessionCtx: { Provider: "telegram", MessageSid: "msg" },
    opts,
  });
}

it("delivers a completed reply with previews and block streaming off", async () => {
  const { setBlockReplyDelivery } = await import("./block-reply-delivery.js");
  const { onAgentEvent } = await import("../../infra/agent-events.js");
  const snapshots: unknown[] = [];
  let cliRunId: string | undefined;
  onTestFinished(
    onAgentEvent((event) => {
      if (event.runId === cliRunId && event.stream === "assistant" && event.data.text) {
        snapshots.push(event.data.text);
      }
    }),
  );
  state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
    cliRunId = params.runId;
    const { emitAgentEvent } = await import("../../infra/agent-events.js");
    emitAgentEvent({
      runId: params.runId,
      stream: "assistant",
      data: { text: "First answer.", delta: "First answer." },
    });
    emitAgentEvent({
      runId: params.runId,
      stream: "assistant",
      data: { completedText: "First answer.", assistantMessageIndex: 0 },
    });
    return {
      payloads: [{ text: "First answer." }, { text: "Final answer." }],
      meta: { finalAssistantVisibleText: "First answer.\nFinal answer." },
    };
  });
  const onBlockReply = vi.fn<NonNullable<GetReplyOptions["onBlockReply"]>>(async () => {
    setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }));
  });
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  const result = await executeAgentTurn(createCliTurn({ onBlockReply }));
  expect(snapshots).toEqual(["First answer.", "First answer.\nFinal answer."]);
  expect(onBlockReply).toHaveBeenCalledOnce();
  expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ text: "First answer." });
  assert(result.kind === "success");
  expect(result.directBlockDeliveries).toEqual([expect.objectContaining({ outcome: "delivered" })]);
  expect(result.runResult.payloads).toEqual([{ text: "First answer." }, { text: "Final answer." }]);
});

it.each([false, true])(
  "waits for prior commentary before completed delivery (start-order=%s)",
  async (preserveProgressCallbackStartOrder) => {
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const { emitAgentEvent } = await import("../../infra/agent-events.js");
      emitAgentEvent({
        runId: params.runId,
        stream: "item",
        data: { kind: "preamble", itemId: "prior-commentary", progressText: "Checking." },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { completedText: "Done.", assistantMessageIndex: 0 },
      });
      return { payloads: [{ text: "Done." }], meta: {} };
    });
    const started = createDeferred();
    const release = createDeferred();
    const order: string[] = [];
    const onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> = async (payload) => {
      order.push(payload.text ?? "");
      if (payload.isCommentary) {
        started.resolve();
        await release.promise;
        order.push("commentary delivered");
      }
    };
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const run = executeAgentTurn(
      createCliTurn({
        onBlockReply,
        commentaryPayloadsEnabled: true,
        preserveProgressCallbackStartOrder,
      }),
    );
    try {
      await Promise.race([
        started.promise,
        run.then(() => {
          throw new Error("CLI completed before commentary started");
        }),
      ]);
      await Promise.resolve();
      expect(order).toEqual(["Checking."]);
    } finally {
      release.resolve();
      await Promise.allSettled([run]);
    }
    expect(order).toEqual(["Checking.", "commentary delivered", "Done."]);
  },
);

it("withholds CLI preview and completed text after queued owner correction without replaying work", async () => {
  const { enqueueFollowupRun } = await import("./queue.js");
  const { clearFollowupQueue } = await import("./queue/state.js");
  const { emitAgentEvent } = await import("../../infra/agent-events.js");
  const onPartialReply = vi.fn();
  const onBlockReply = vi.fn();
  const turn = createCliTurn({ onPartialReply, onBlockReply });
  const queueKey =
    turn.sessionKey ?? turn.followupRun.run.sessionKey ?? turn.followupRun.run.sessionId;
  onTestFinished(() => clearFollowupQueue(queueKey));
  const completedToolWork = vi.fn();
  state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
    completedToolWork();
    const queued = {
      ...turn.followupRun,
      prompt: "Please use the latest correction",
      messageId: "correction",
    };
    enqueueFollowupRun(
      queueKey,
      queued,
      { mode: "steer", debounceMs: 0 },
      "message-id",
      undefined,
      false,
    );
    emitAgentEvent({
      runId: params.runId,
      stream: "assistant",
      data: { text: "Outdated answer", delta: "Outdated answer" },
    });
    emitAgentEvent({
      runId: params.runId,
      stream: "assistant",
      data: { completedText: "Outdated answer", assistantMessageIndex: 0 },
    });
    return {
      payloads: [{ text: "Outdated answer" }],
      meta: { finalAssistantVisibleText: "Outdated answer" },
    };
  });
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  const result = await executeAgentTurn(turn);
  expect(result.kind).toBe("success");
  expect(onPartialReply).not.toHaveBeenCalled();
  expect(onBlockReply).not.toHaveBeenCalled();
  expect(completedToolWork).toHaveBeenCalledOnce();
  expect(state.runCliAgentMock).toHaveBeenCalledOnce();
  assert(result.kind === "success");
  expect(result.runResult.payloads).toEqual([{ text: "Outdated answer" }]);
});
