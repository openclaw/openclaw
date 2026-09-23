import { expect, it, vi, type Mock } from "vitest";
import type { RunEmbeddedAgentInternalParams as AgentRunParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { mockAcceptedWaitingStatusRun } from "./agent-runner.runreplyagent.waiting-status.cases.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun } from "./queue.js";

type RequiredReplyFixture = {
  createMinimalRun: (params?: {
    opts?: InternalGetReplyOptions;
    blockStreamingEnabled?: boolean;
    currentInboundEventKind?: FollowupRun["currentInboundEventKind"];
    runOverrides?: Partial<FollowupRun["run"]>;
  }) => {
    followupRun: FollowupRun;
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
  };
  state: {
    runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce" | "mockResolvedValueOnce">;
  };
  requireScheduledFollowupRunner: () => (run: FollowupRun) => Promise<void>;
};

export function registerRequiredReplyCompletionCases({
  createMinimalRun,
  state,
  requireScheduledFollowupRunner,
}: RequiredReplyFixture): void {
  it("suppresses narrated silent-turn partials, block replies, and final payloads", async () => {
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
      opts: { isHeartbeat: false, onPartialReply, onBlockReply, onReasoningStream },
      blockStreamingEnabled: true,
      runOverrides: { silentExpected: true, terminalReplyExpectation: "optional" },
    });
    const res = await run();

    expect(onReasoningStream).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
  });

  it.each(["required", "optional"] as const)(
    "honors %s completion despite silentExpected and bare NO_REPLY payloads",
    async (terminalReplyExpectation) => {
      const onPartialReply = vi.fn();
      const onBlockReply = vi.fn();
      const onReasoningStream = vi.fn();
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        expect(params.silentExpected).toBe(true);
        await params.onReasoningStream?.({ text: "Reasoning:\nNO_REPLY" });
        await params.onPartialReply?.({ text: "NO_REPLY" });
        await params.onBlockReply?.({ text: "NO_REPLY" });
        return { payloads: [{ text: "NO_REPLY" }], meta: { finalAssistantText: "NO_REPLY" } };
      });

      const { run } = createMinimalRun({
        opts: { isHeartbeat: false, onPartialReply, onBlockReply, onReasoningStream },
        blockStreamingEnabled: true,
        runOverrides: { silentExpected: true, terminalReplyExpectation },
      });
      const res = await run();

      expect(onReasoningStream).not.toHaveBeenCalled();
      expect(onPartialReply).not.toHaveBeenCalled();
      expect(onBlockReply).not.toHaveBeenCalled();
      if (terminalReplyExpectation === "required") {
        const payloads = Array.isArray(res) ? res : [res];
        expect(payloads).toContainEqual(expect.objectContaining({ isError: true }));
      } else {
        expect(res).toBeUndefined();
      }
    },
  );

  it.each([false, true])("settles a required queued answer with explicit silence=%s", async (silent) => {
    state.runEmbeddedAgentMock
      .mockResolvedValueOnce({ payloads: [], meta: {} })
      .mockResolvedValueOnce({
        payloads: [{ text: "NO_REPLY" }],
        meta: silent ? { finalAssistantRawText: "NO_REPLY", finalAssistantVisibleText: "" } : {},
      });
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    const heartbeat = createMinimalRun({
      opts: { isHeartbeat: true, onBlockReply },
      runOverrides: { terminalReplyExpectation: "optional" },
    });
    await expect(heartbeat.run()).resolves.toBeUndefined();
    expect(onBlockReply).not.toHaveBeenCalled();

    const queued = createMinimalRun({
      currentInboundEventKind: "user_request",
      runOverrides: { terminalReplyExpectation: "required" },
    });
    await requireScheduledFollowupRunner()(queued.followupRun);

    if (silent) {
      expect(onBlockReply).not.toHaveBeenCalled();
    } else {
      expect(onBlockReply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ isError: true, text: expect.any(String) }),
      );
    }
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
  });

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
        text: expect.stringContaining("did not produce a visible reply"),
        isError: true,
        replyToId: "msg",
      }),
    );
  });

  it("surfaces a marked fallback for an empty message-tool-only completion", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const { run } = createMinimalRun({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
    });

    const result = await run();
    const payload = Array.isArray(result) ? result[0] : result;

    expect(payload).toMatchObject({
      text: expect.stringContaining("did not produce a visible reply"),
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
        text: expect.stringContaining("did not produce a visible reply"),
        isError: true,
      }),
    );
  });

  it.each([
    {
      label: "NO_REPLY",
      pendingContinuation: false,
      expectation: "required",
      result: {
        payloads: [{ text: "NO_REPLY" }],
        meta: { finalAssistantVisibleText: "NO_REPLY" },
      },
      missing: false,
    },
    {
      label: "optional NO_REPLY",
      pendingContinuation: false,
      expectation: "optional",
      result: {
        payloads: [{ text: "NO_REPLY" }],
        meta: { finalAssistantVisibleText: "NO_REPLY" },
      },
      missing: false,
    },
    {
      label: "pending tool continuation",
      pendingContinuation: true,
      expectation: "required",
      result: { payloads: [], meta: { pendingToolCalls: [{ name: "hosted_tool" }] } },
      missing: false,
    },
  ] as const)(
    "settles $label according to its reply obligation",
    async ({ result, pendingContinuation, expectation, missing }) => {
      state.runEmbeddedAgentMock.mockResolvedValueOnce(result);
      const onPendingContinuation = vi.fn();
      const { run } = createMinimalRun({
        opts: { onPendingContinuation },
        runOverrides: { terminalReplyExpectation: expectation },
      });

      if (missing) {
        await expect(run()).resolves.toMatchObject({ isError: true });
      } else {
        await expect(run()).resolves.toBeUndefined();
      }
      expect(onPendingContinuation).toHaveBeenCalledTimes(pendingContinuation ? 1 : 0);
    },
  );

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
      params: { currentInboundEventKind: "room_event" as const },
    },
    {
      label: "internal handoff",
      params: {
        runOverrides: {
          inputProvenance: { kind: "internal_system" as const, sourceTool: "restart-sentinel" },
        },
      },
    },
  ])("keeps successful empty $label completions silent", async ({ params }) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const { run } = createMinimalRun(params);

    await expect(run()).resolves.toBeUndefined();
  });
}
