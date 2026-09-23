import { randomUUID } from "node:crypto";
import { assert, expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { createSubagentRunParams } from "../../agents/subagent-test-fixtures.test-helpers.js";
import {
  markRequesterTurnYielded,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplySource, setBlockReplyDelivery } from "./block-reply-delivery.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import * as pendingToolTaskDrain from "./pending-tool-task-drain.js";

type WaitingStatusFixture = {
  createMinimalRun: (params?: {
    opts?: InternalGetReplyOptions;
    currentInboundEventKind?: "room_event";
  }) => {
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
  };
  runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce">;
};

export async function mockAcceptedWaitingStatusRun(
  runner: WaitingStatusFixture["runEmbeddedAgentMock"],
  result:
    | EmbeddedAgentRunResult
    | ((params: RunEmbeddedAgentInternalParams) => Promise<EmbeddedAgentRunResult>),
): Promise<void> {
  const testState = await createOpenClawTestState({ label: "reply-waiting-child" });
  resetSubagentRegistryForTests({ persist: false });
  onTestFinished(async () => {
    resetSubagentRegistryForTests({ persist: false });
    await testState.cleanup();
  });
  runner.mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
    assert(params.preparedRunAdmission);
    assert(params.sessionKey);
    await params.preparedRunAdmission.admit("embedded");
    const spawn = {
      runId: randomUUID(),
      childSessionKey: "agent:main:subagent:waiting-child",
      expectsCompletionMessage: true,
    };
    const requester = {
      requesterSessionKey: params.sessionKey,
      requesterAgentId: params.agentId,
      requesterTurnRunId: params.runId,
    };
    await registerSubagentRun(createSubagentRunParams({ ...spawn, ...requester, queued: true }));
    const runResult = typeof result === "function" ? await result(params) : result;
    if (runResult.meta.yielded) {
      expect(markRequesterTurnYielded(requester)).toBe(1);
    }
    return { ...runResult, acceptedSessionSpawns: [spawn] };
  });
}

export function registerWaitingStatusCases({
  createMinimalRun,
  runEmbeddedAgentMock,
}: WaitingStatusFixture): void {
  it.each([
    {
      label: "implicit continuation",
      meta: { continuationPending: true as const },
    },
    { label: "yield without acknowledgment", meta: { yielded: true } },
    {
      label: "explicit acknowledgment",
      meta: { yielded: true, yieldAcknowledgment: "Research started; results will follow." },
    },
  ])("delivers one waiting status for $label", async ({ meta }) => {
    await mockAcceptedWaitingStatusRun(runEmbeddedAgentMock, {
      payloads: [],
      meta: { durationMs: 0, ...meta },
    });
    const onPendingContinuation = vi.fn();
    const { run } = createMinimalRun({ opts: { onPendingContinuation } });

    const result = await run();
    expect(result).toMatchObject({
      text:
        meta.yieldAcknowledgment ??
        "I’m continuing this work and will send the result when it is ready.",
      replyToId: "msg",
    });
    expect(onPendingContinuation).toHaveBeenCalledOnce();
    assert(result && !Array.isArray(result));
    const metadata = getReplyPayloadMetadata(result);
    expect(metadata).toMatchObject({
      continuationStatus: true,
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it.each([false, true])(
    "uses direct delivery completeness at settlement for waiting status (complete=%s)",
    async (completeAtSettlement) => {
      const source = createBlockReplySource();
      source.setComplete(completeAtSettlement);
      const onBlockReply = vi.fn(async (payload: ReplyPayload) => {
        await source.run(async () => {
          setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }), payload);
        });
      });
      await mockAcceptedWaitingStatusRun(runEmbeddedAgentMock, async (params) => {
        await params.onBlockReply?.({
          text: "Delivered caption",
          mediaUrls: ["https://example.com/direct.png"],
        });
        source.setComplete(!completeAtSettlement);
        return {
          payloads: [],
          meta: { durationMs: 0, yielded: true, yieldAcknowledgment: "Waiting sentinel" },
        };
      });
      const { run } = createMinimalRun({ opts: { onBlockReply } });

      const result = await run();

      expect(onBlockReply).toHaveBeenCalledOnce();
      if (completeAtSettlement) {
        expect(result).toBeUndefined();
      } else {
        expect(result).toMatchObject({ text: "Waiting sentinel", replyToId: "msg" });
      }
    },
  );

  it.each([
    { phase: "deferred cleanup", late: "final", earlierSuccess: false },
    { phase: "deferred cleanup", late: "progress", earlierSuccess: false },
    { phase: "deferred cleanup", late: "progress", earlierSuccess: true },
    { phase: "task drain", late: "final", earlierSuccess: false },
    { phase: "task drain", late: "progress", earlierSuccess: false },
    { phase: "task drain", late: "progress", earlierSuccess: true },
  ])(
    "settles $late delivery during $phase without redundant replies (earlier success=$earlierSuccess)",
    async ({ phase, late, earlierSuccess }) => {
      const transportStarted = createDeferred();
      const releaseTransport = createDeferred();
      const delivered: string[] = [];
      let lateDelivery: Promise<void> | undefined;
      const events: string[] = [];
      const onBlockReply = vi.fn(async (payload: ReplyPayload) => {
        if (payload.text === "Late caption") {
          transportStarted.resolve();
          await releaseTransport.promise;
          events.push("delivered");
        }
        delivered.push(payload.text ?? "");
      });
      const onToolResult = vi.fn(async () => {
        await lateDelivery;
        events.push("tool completed");
      });
      const originalDrain = pendingToolTaskDrain.drainPendingToolTasks;
      const drainSpy =
        phase === "task drain"
          ? vi
              .spyOn(pendingToolTaskDrain, "drainPendingToolTasks")
              .mockImplementation((options) => {
                events.push("drain started");
                const draining = originalDrain(options);
                releaseTransport.resolve();
                return draining;
              })
          : undefined;
      await mockAcceptedWaitingStatusRun(runEmbeddedAgentMock, async (params) => {
        if (earlierSuccess) {
          await params.onBlockReply?.({
            text: "Earlier caption",
            mediaUrls: ["https://example.com/earlier.png"],
          });
        }
        lateDelivery = Promise.resolve(
          params.onBlockReply?.({
            text: "Late caption",
            mediaUrls: ["https://example.com/late.png"],
            isCommentary: late === "progress",
          }),
        );
        await transportStarted.promise;
        if (phase === "task drain") {
          void params.onToolResult?.({ text: "Pending tool delivery" });
        }
        params.onDeferredLifecycleOwner?.({
          beginRetryWait: () => undefined,
          discard: () => undefined,
          complete: async () => {
            if (phase === "deferred cleanup") {
              releaseTransport.resolve();
              await lateDelivery;
            }
            events.push("cleanup completed");
          },
        });
        return {
          payloads: [],
          meta: { durationMs: 0, yielded: true, yieldAcknowledgment: "Waiting sentinel" },
        };
      });
      const { run } = createMinimalRun({
        opts: {
          onBlockReply,
          onToolResult,
          forceToolResultProgress: true,
          commentaryPayloadsEnabled: true,
        },
      });

      try {
        const result = await run();

        expect(delivered).toEqual(
          earlierSuccess ? ["Earlier caption", "Late caption"] : ["Late caption"],
        );
        expect(events).toEqual(
          phase === "task drain"
            ? ["cleanup completed", "drain started", "delivered", "tool completed"]
            : ["delivered", "cleanup completed"],
        );
        if (earlierSuccess || late === "final") {
          expect(result).toBeUndefined();
        } else {
          expect(result).toMatchObject({ text: "Waiting sentinel", replyToId: "msg" });
        }
      } finally {
        releaseTransport.resolve();
        await lateDelivery;
        drainSpy?.mockRestore();
      }
    },
  );

  it.each([
    { label: "default status" },
    { label: "explicit status", acknowledgment: "Research started; results will follow." },
    {
      label: "room event",
      acknowledgment: "Research started; results will follow.",
      roomEvent: true,
      warning: true,
    },
    { label: "empty acknowledgment", acknowledgment: "[[reply_to_current]]", warning: true },
  ])("resolves an earlier tool warning with $label", async (testCase) => {
    const toolWarning = setReplyPayloadMetadata(
      { text: "⚠️ Bash failed", isError: true },
      { toolErrorWarning: { toolName: "bash" } },
    );
    await mockAcceptedWaitingStatusRun(runEmbeddedAgentMock, {
      payloads: [toolWarning],
      meta: { durationMs: 0, yielded: true, yieldAcknowledgment: testCase.acknowledgment },
    });
    const { run } = createMinimalRun({
      currentInboundEventKind: testCase.roomEvent ? "room_event" : undefined,
    });

    await expect(run()).resolves.toMatchObject({
      text: testCase.warning
        ? "⚠️ Bash failed"
        : (testCase.acknowledgment ??
          "I’m continuing this work and will send the result when it is ready."),
      ...(testCase.warning ? { isError: true } : {}),
      replyToId: "msg",
    });
  });
}
