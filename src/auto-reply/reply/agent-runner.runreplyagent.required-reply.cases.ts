import { expect, it, vi, type Mock } from "vitest";
import type { RunEmbeddedAgentInternalParams as AgentRunParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { findSessionControllerOperationByRunId } from "../../sessions/session-controller.queries.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { mockAcceptedWaitingStatusRun } from "./agent-runner.runreplyagent.waiting-status.cases.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun } from "./queue.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { resolveReplyOperationAgentTurn } from "./reply-operation-run-state.test-support.js";

type RequiredReplyFixture = {
  createMinimalRun: (params?: {
    opts?: InternalGetReplyOptions;
    blockStreamingEnabled?: boolean;
    currentInboundEventKind?: FollowupRun["currentInboundEventKind"];
    sessionCtx?: { MessageSid?: string };
    runOverrides?: Partial<FollowupRun["run"]>;
  }) => {
    followupRun: FollowupRun;
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
  };
  state: {
    runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce" | "mockResolvedValueOnce">;
  };
};

export function registerRequiredReplyCompletionCases({
  createMinimalRun,
  state,
}: RequiredReplyFixture): void {
  it("reports missing output after filtering silentExpected narration", async () => {
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();
    const onReasoningStream = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      expect(params.silentExpected).toBe(true);
      await params.onReasoningStream?.({ text: "Reasoning:\nI am trying to send NO_REPLY now." });
      await params.onPartialReply?.({ text: "I am trying to send NO_REPLY now." });
      await params.onBlockReply?.({ text: "I am trying to send NO_REPLY now." });
      return { payloads: [{ text: "I am trying to send NO_REPLY now." }], meta: {} };
    });

    const { run } = createMinimalRun({
      opts: { onPartialReply, onBlockReply, onReasoningStream },
      blockStreamingEnabled: true,
      runOverrides: { silentExpected: true, terminalReplyExpectation: "required" },
    });
    const res = await run();

    expect(onReasoningStream).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      text: "No answer was returned. Ask again if you still need one.",
      isError: true,
      isStatusNotice: true,
    });
  });

  it.each(["required", "optional"] as const)(
    "honors %s completion with a prepared silent outcome",
    async (terminalReplyExpectation) => {
      const onPartialReply = vi.fn();
      const onBlockReply = vi.fn();
      const onReasoningStream = vi.fn();
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        expect(params.silentExpected).toBe(true);
        return {
          payloads: [],
          meta: { finalAssistantRawText: "NO_REPLY", terminalReply: { disposition: "silent" } },
        };
      });

      const { run } = createMinimalRun({
        opts: { onPartialReply, onBlockReply, onReasoningStream },
        blockStreamingEnabled: true,
        runOverrides: { silentExpected: true, terminalReplyExpectation },
      });
      const res = await run();

      expect(onReasoningStream).not.toHaveBeenCalled();
      expect(onPartialReply).not.toHaveBeenCalled();
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(res).toBeUndefined();
    },
  );

  it.each([
    { label: "empty output", payloads: [] },
    { label: "reasoning-only output", payloads: [{ text: "internal", isReasoning: true }] },
    { label: "commentary-only output", payloads: [{ text: "internal", isCommentary: true }] },
    { label: "directive-only output", payloads: [{ text: "[[reply_to_current]]" }] },
  ])("surfaces successful $label through normal reply delivery", async ({ payloads }) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads, meta: {} });
    const { run } = createMinimalRun({
      runOverrides: { config: { channels: { whatsapp: { replyToMode: "first" } } } },
    });

    const result = await run();
    const payloadsResult = Array.isArray(result) ? result : [result];

    expect(payloadsResult).toContainEqual(
      expect.objectContaining({
        text: "No answer was returned. Ask again if you still need one.",
        isError: true,
        replyToId: "msg",
      }),
    );
  });

  it.each([
    { mode: "message_tool_only", reportsEarly: true },
    { mode: "automatic", reportsEarly: false },
  ] as const)(
    "reports a message-tool source reply mid-run only in $mode delivery: $reportsEarly",
    async ({ mode, reportsEarly }) => {
      const onObservedReplyDelivery = vi.fn();
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        const operation = findSessionControllerOperationByRunId(params.runId);
        expect(operation).toBeDefined();
        operation?.markSourceReplyDelivered();
        // Channel progress UI must stop before later tool events of this run render.
        expect(onObservedReplyDelivery).toHaveBeenCalledTimes(reportsEarly ? 1 : 0);
        return { payloads: [], meta: {} };
      });
      const { run } = createMinimalRun({
        opts: { sourceReplyDeliveryMode: mode, onObservedReplyDelivery },
        runOverrides: { sourceReplyDeliveryMode: mode },
      });

      await run();
    },
  );

  it("surfaces a marked fallback for an empty message-tool-only completion", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const { run } = createMinimalRun({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
    });

    const result = await run();
    const payload = Array.isArray(result) ? result[0] : result;

    expect(payload).toMatchObject({
      text: "No answer was returned. Ask again if you still need one.",
      isError: true,
    });
    expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it.each([
    { lane: "reasoning", payload: { text: "internal", isReasoning: true } },
    { lane: "commentary", payload: { text: "internal", isCommentary: true } },
  ])("does not let streamed $lane suppress the empty-reply fallback", async ({ payload }) => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onBlockReply?.(payload);
      return { payloads: [], meta: {} };
    });
    const { run } = createMinimalRun({
      blockStreamingEnabled: true,
      opts: {
        onBlockReply,
        reasoningPayloadsEnabled: true,
        commentaryPayloadsEnabled: true,
      },
    });

    const result = await run();
    const payloads = Array.isArray(result) ? result : [result];

    expect(onBlockReply).toHaveBeenCalled();
    expect(onBlockReply.mock.calls[0]?.[0]).toEqual(expect.objectContaining(payload));
    expect(payloads).toContainEqual(
      expect.objectContaining({
        text: "No answer was returned. Ask again if you still need one.",
        isError: true,
      }),
    );
  });

  it("retains pending tool continuation without a terminal reply", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: { pendingToolCalls: [{ name: "hosted_tool" }] },
    });
    const onPendingContinuation = vi.fn();
    const { run } = createMinimalRun({
      opts: { onPendingContinuation },
      runOverrides: { terminalReplyExpectation: "required" },
    });
    await expect(run()).resolves.toBeUndefined();
    expect(onPendingContinuation).toHaveBeenCalledOnce();
  });

  it("delivers a required yield acknowledgment despite silentExpected in message-tool-only mode", async () => {
    await mockAcceptedWaitingStatusRun(state.runEmbeddedAgentMock, {
      payloads: [],
      meta: {
        durationMs: 0,
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      },
    });
    const { run } = createMinimalRun({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
      runOverrides: { silentExpected: true, terminalReplyExpectation: "required" },
    });

    const result = await run();
    const payloads = Array.isArray(result) ? result : result ? [result] : [];

    expect(payloads.map((payload) => payload.text)).toEqual([
      "Research started; results will follow.",
    ]);
    expect(getReplyPayloadMetadata(payloads[0] ?? {})).toMatchObject({
      continuationStatus: true,
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it.each([
    {
      label: "room event",
      params: { currentInboundEventKind: "room_event" as const, opts: {} },
      expectedStatus: "ok",
    },
    {
      label: "internal handoff",
      params: {
        opts: {},
        runOverrides: {
          inputProvenance: { kind: "internal_system" as const, sourceTool: "restart-sentinel" },
        },
      },
      expectedStatus: "ok",
    },
  ])(
    "settles optional empty $label turns without a chat notice",
    async ({ params, expectedStatus }) => {
      state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
      const onAgentRunTerminalOutcome = vi.fn();
      const runState: ReplyOperationRunState = {};
      const { run } = createMinimalRun({
        ...params,
        opts: { ...params.opts, onAgentRunTerminalOutcome, [REPLY_OPERATION_RUN_STATE]: runState },
      });

      await expect(run()).resolves.toBeUndefined();
      expect(onAgentRunTerminalOutcome).toHaveBeenLastCalledWith(
        expectedStatus === "failed" ? "failed" : "completed",
      );
      expect(resolveReplyOperationAgentTurn(runState)).toBe(expectedStatus);
    },
  );
}
