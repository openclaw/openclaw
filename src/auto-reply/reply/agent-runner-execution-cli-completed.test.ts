import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  createAgentTurnExecutionDefaults,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  runInitialFallbackAttempt,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

it.each(["delivered", "failed-before-deliver"] as const)(
  "delivers a completed reply with previews and block streaming off, retaining only retryable segments (%s)",
  async (outcome) => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await runInitialFallbackAttempt(params, "claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    const { createBlockReplyDeliveryHandler } =
      await vi.importActual<typeof import("./reply-delivery.js")>("./reply-delivery.js");
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
    state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
      createBlockReplyDeliveryHandler,
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
      setBlockReplyDelivery(Promise.resolve({ outcome }));
    });
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: { onBlockReply },
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
      blockStreamingEnabled: false,
    });
    expect(snapshots).toEqual(["First answer.", "First answer.\nFinal answer."]);
    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ text: "First answer." });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") {
      throw new Error("Expected successful CLI settlement");
    }
    expect(result.directBlockDeliveries).toEqual([expect.objectContaining({ outcome })]);
    expect(result.runResult.payloads).toEqual([
      { text: "First answer." },
      { text: "Final answer." },
    ]);
  },
);

it.each([false, true])(
  "waits for prior commentary before completed delivery (start-order=%s)",
  async (preserveProgressCallbackStartOrder) => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await runInitialFallbackAttempt(params, "claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));
    const { createBlockReplyDeliveryHandler } =
      await vi.importActual<typeof import("./reply-delivery.js")>("./reply-delivery.js");
    state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
      createBlockReplyDeliveryHandler,
    );
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
    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-opus-4-6";
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const run = executeAgentTurn({
      commandBody: "hi",
      followupRun,
      sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      opts: { onBlockReply, commentaryPayloadsEnabled: true, preserveProgressCallbackStartOrder },
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
      blockStreamingEnabled: false,
    });
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
