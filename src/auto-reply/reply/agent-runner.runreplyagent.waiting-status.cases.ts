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
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplySource, setBlockReplyDelivery } from "./block-reply-delivery.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import * as pendingToolTaskDrain from "./pending-tool-task-drain.js";

type WaitingStatusFixture = {
  createMinimalRun: (params?: { opts?: InternalGetReplyOptions }) => {
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
  };
  runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce" | "mockResolvedValueOnce">;
};

export async function mockAcceptedWaitingStatusRun(
  runner: WaitingStatusFixture["runEmbeddedAgentMock"],
  result: EmbeddedAgentRunResult,
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
    registerSubagentRun(createSubagentRunParams({ ...spawn, ...requester, queued: true }));
    if (result.meta.yielded) {
      expect(markRequesterTurnYielded(requester)).toBe(1);
    }
    return { ...result, acceptedSessionSpawns: [spawn] };
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
      implicit: true,
    },
    { label: "yield without acknowledgment", meta: { yielded: true }, implicit: false },
    {
      label: "explicit acknowledgment",
      meta: { yielded: true, yieldAcknowledgment: "Research started; results will follow." },
      implicit: false,
    },
  ])("delivers one waiting status for $label", async ({ meta, implicit }) => {
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
    expect(metadata?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(onPendingContinuation.mock.calls[0]).toEqual(
      implicit ? [{ settle: expect.any(Function) }] : [],
    );
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
      runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
          await params.onBlockReply?.({
            text: "Delivered caption",
            mediaUrls: ["https://example.com/direct.png"],
          });
          source.setComplete(!completeAtSettlement);
          return { payloads: [], meta: { yielded: true, yieldAcknowledgment: "Waiting sentinel" } };
        },
      );
      const { run } = createMinimalRun({ opts: { onBlockReply } });

      const result = await run();

      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(source.complete).toBe(!completeAtSettlement);
      if (completeAtSettlement) {
        expect(result).toBeUndefined();
      } else {
        expect(result).toMatchObject({ text: "Waiting sentinel", replyToId: "msg" });
      }
    },
  );

  it.each([
    { phase: "deferred cleanup", earlierSuccess: false },
    { phase: "deferred cleanup", earlierSuccess: true },
    { phase: "task drain", earlierSuccess: false },
    { phase: "task drain", earlierSuccess: true },
  ])(
    "preserves waiting status when direct delivery settles during $phase (earlier success=$earlierSuccess)",
    async ({ phase, earlierSuccess }) => {
      const transportStarted = createDeferred();
      const releaseTransport = createDeferred();
      const delivered: string[] = [];
      let lateDelivery: Promise<void> | undefined;
      let cleanupCompleted = false;
      let drainSnapshot: { cleanupCompleted: boolean; delivered: string[] } | undefined;
      const onBlockReply = vi.fn(async (payload: ReplyPayload) => {
        if (payload.text === "Late caption") {
          transportStarted.resolve();
          await releaseTransport.promise;
        }
        delivered.push(payload.text ?? "");
      });
      const onToolResult = vi.fn(async () => {
        await lateDelivery;
      });
      const originalDrain = pendingToolTaskDrain.drainPendingToolTasks;
      const drainSpy =
        phase === "task drain"
          ? vi
              .spyOn(pendingToolTaskDrain, "drainPendingToolTasks")
              .mockImplementation((options) => {
                drainSnapshot = { cleanupCompleted, delivered: [...delivered] };
                const draining = originalDrain(options);
                releaseTransport.resolve();
                return draining;
              })
          : undefined;
      runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
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
              cleanupCompleted = true;
            },
          });
          return { payloads: [], meta: { yielded: true, yieldAcknowledgment: "Waiting sentinel" } };
        },
      );
      const { run } = createMinimalRun({
        opts: { onBlockReply, onToolResult, forceToolResultProgress: true },
      });

      try {
        const result = await run();

        expect(cleanupCompleted).toBe(true);
        expect(delivered).toEqual(
          earlierSuccess ? ["Earlier caption", "Late caption"] : ["Late caption"],
        );
        if (drainSpy) {
          expect(drainSpy).toHaveBeenCalledOnce();
          expect(onToolResult).toHaveBeenCalledOnce();
          expect(drainSnapshot).toEqual({
            cleanupCompleted: true,
            delivered: earlierSuccess ? ["Earlier caption"] : [],
          });
        }
        if (earlierSuccess) {
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
}
