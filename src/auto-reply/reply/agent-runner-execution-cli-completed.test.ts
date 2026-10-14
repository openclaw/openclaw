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
