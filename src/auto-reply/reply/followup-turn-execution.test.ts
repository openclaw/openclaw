import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { markReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnExecutionResult, AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createFollowupTurnTestTypingController as createTypingController,
  createFollowupTurnTestTurn as createTurn,
  executeFollowupTurnForTest as executeFollowupTurn,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createMockReplyOperation } from "./test-helpers.js";

const state = getFollowupTurnTestState();

beforeEach(resetFollowupTurnTestState);

type FollowupTurnParams = Parameters<typeof executeFollowupTurn>[0];

function executeTestTurn({
  run,
  ...params
}: Partial<Omit<FollowupTurnParams, "defaults">> & {
  defaults?: Partial<FollowupTurnParams["defaults"]>;
  opts?: FollowupTurnParams["defaults"]["opts"];
  run?: Parameters<typeof stubExecution>[0];
}) {
  if (run) {
    stubExecution(run);
  }
  return executeFollowupTurn({
    ...params,
    turn: params.turn ?? createTurn(),
    defaults: {
      typing: createTypingController(),
      typingMode: "never",
      defaultModel: "claude",
      opts: params.opts,
      ...params.defaults,
    },
    onToolResult: params.onToolResult ?? vi.fn(async () => {}),
    onCompactionNoticePayload: params.onCompactionNoticePayload ?? vi.fn(async () => {}),
  });
}

function createSession(
  current: () => Partial<InternalSessionEntry>,
): AdmittedFollowupTurn["session"] {
  return {
    kind: "session",
    key: "main",
    publish: () => undefined,
    current: () => ({ sessionId: "session", updatedAt: 1, ...current() }),
  };
}

function stubExecution(effect: (params: AgentTurnParams) => unknown | Promise<unknown>) {
  state.execute.mockImplementation(async (params: AgentTurnParams) => {
    await effect(params);
    return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
  });
}

async function runFastAutoProgressCase(params: {
  verboseLevel?: "on" | "off";
  sourceReplyDeliveryMode?: "message_tool_only";
  callbackResult?: boolean;
  opts?: NonNullable<Parameters<typeof executeFollowupTurn>[0]["defaults"]["opts"]>;
  payload?: ReplyPayload;
}) {
  const payload =
    params.payload ??
    ({
      text: "💨Fast: auto-on",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload);
  const onChannelToolResult = vi.fn(() => params.callbackResult);
  const onDurableToolResult = vi.fn(async () => {});
  const turn = createTurn({
    session: createSession(() => ({
      verboseLevel: params.verboseLevel ?? "on",
    })),
  });
  turn.queued.run.sourceReplyDeliveryMode = params.sourceReplyDeliveryMode;
  const result = await executeTestTurn({
    turn,
    run: async (execution) => {
      await execution.opts?.onToolResult?.(payload);
    },
    opts: { ...params.opts, onToolResult: onChannelToolResult },
    onToolResult: onDurableToolResult,
  });
  await result.progress.drain();
  return { onChannelToolResult, onDurableToolResult, payload };
}

describe("executeFollowupTurn", () => {
  it("retains the queued turn's restart restrictions over later runner defaults", async () => {
    const turn = createTurn();
    turn.queued.forceRestartSafeTools = true;
    turn.queued.forceCodeModeTools = true;
    await executeTestTurn({
      turn,
      opts: { forceRestartSafeTools: false, forceCodeModeTools: false },
    });
    expect(state.execute.mock.calls[0]?.[0]?.opts).toMatchObject({
      forceRestartSafeTools: true,
      forceCodeModeTools: true,
    });
  });

  it("refreshes the eligible queued turn from its current personal profile", async () => {
    const turn = createTurn({
      session: createSession(() => ({
        updatedAt: 2,
        createdActor: { type: "human", source: "profile", id: "creator" },
        owner: { actor: { type: "human", id: "new-owner" } },
      })),
    });
    turn.queued.personalBootstrapEligible = true;
    turn.queued.run.bootstrapUserProfileId = "previous-owner";
    await executeTestTurn({ turn });
    expect(state.execute.mock.calls[0]?.[0]?.followupRun.run.bootstrapUserProfileId).toBe(
      "new-owner",
    );
  });

  it("records preflight failure on source receipts without changing newer runner state", async () => {
    const receipts: ReplyOperationRunState[] = [{}, {}];
    const newerReceipt: ReplyOperationRunState = {};
    const turn = createTurn();
    turn.queued.replyOperationRunStates = receipts;
    turn.preflightFailurePayload = { text: "preflight failed" };

    await executeTestTurn({
      turn,
      opts: { [REPLY_OPERATION_RUN_STATE]: newerReceipt },
    });

    expect(receipts.map(resolveReplyOperationAgentTurn)).toEqual(["failed", "failed"]);
    expect(resolveReplyOperationAgentTurn(newerReceipt)).toBeUndefined();
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("gives queued media to its completion owner", async () => {
    const turn = createTurn();
    turn.queued.queuedFollowupReplyDisposition = {
      kind: "deliver",
      deliver: Object.assign(async () => {}, { ownsCompletion: () => true }),
    };
    await executeTestTurn({ turn });
    expect(state.execute.mock.calls[0]?.[0]?.followupRun.run.mediaNormalizationOwner).toBe(
      "gateway",
    );
  });

  it("normalizes queued route facts into the canonical execution call", async () => {
    const turn = createTurn();
    const typing = createTypingController();
    const onAgentRunStart = vi.fn();
    turn.queued.runObservers = { onAgentRunStart };
    await executeTestTurn({
      turn,
      run: (params) => {
        params.opts?.onAgentRunStart?.("run-1");
      },
      defaults: {
        typing,
        typingMode: "instant",
      },
    });

    const call = state.execute.mock.calls[0]?.[0] as AgentTurnParams;
    expect(call).toMatchObject({
      commandBody: "queued prompt",
      transcriptCommandBody: "queued transcript",
      followupRun: turn.queued,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      sessionKey: "main",
    });
    expect(call.opts?.runId).toBe("run-1");
    expect(call.sessionCtx).toMatchObject({
      Provider: "slack",
      Surface: "discord",
      SessionKey: "main",
      RuntimePolicySessionKey: "main",
      OriginatingTo: "channel:C1",
      MessageThreadId: "thread-1",
      MessageSid: "message-1",
      SenderId: "user-1",
    });
    expect(call.sessionCtx.media).toEqual([{ kind: "audio", contentType: "audio/ogg" }]);
    expect(onAgentRunStart).toHaveBeenCalledWith("run-1");
  });

  it("uses turn-owned preference updates for awaited visibility", async () => {
    let verboseLevel: "off" | "full" = "off";
    const turn = createTurn({
      session: createSession(() => ({ verboseLevel })),
    });
    const legacy = vi.fn();
    await executeTestTurn({
      turn,
      opts: {
        onVerboseProgressVisibility: legacy,
        onVerboseProgressVisibilityAsync: async (isActive) => {
          expect(await isActive()).toBe(false);
          verboseLevel = "full";
          expect(await isActive()).toBe(true);
          turn.queued.run.verboseLevelOverride = "off";
          expect(await isActive()).toBe(false);
        },
      },
    });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("freezes commentary ownership for a queued on-to-off transition", async () => {
    let verboseLevel: "on" | "off" = "off";
    let isVerboseProgressActive = () => true;
    const turn = createTurn({
      session: createSession(() => ({ verboseLevel })),
    });
    const result = await executeTestTurn({
      turn,
      run: (params) => {
        expect(params.resolvedVerboseLevel).toBe("off");
        expect(params.opts?.commentaryPayloadsEnabled).toBe(false);
        verboseLevel = "on";
        expect(isVerboseProgressActive()).toBe(false);
      },
      opts: {
        commentaryPayloadsEnabled: true,
        shouldDeliverCommentaryPayloads: () => isVerboseProgressActive(),
        onVerboseProgressVisibility: (getter) => {
          isVerboseProgressActive = getter;
        },
      },
    });

    expect(result.commentaryPayloadsEnabled).toBe(false);
  });

  it.each(["optional", "required", "result-required"] as const)(
    "uses queued %s requiredness for previews but preserves media",
    async (expectation) => {
      const turn = createTurn();
      turn.queued.run.terminalReplyExpectation = expectation;
      turn.queued.run.verboseLevelOverride = "off";
      const onItemEvent = vi.fn(async () => true);
      const onDurableToolResult = vi.fn(async () => {});
      const media = { mediaUrl: "https://example.test/result.png" };
      const result = await executeTestTurn({
        turn,
        run: async (params) => {
          await params.opts?.onItemEvent?.({ kind: "tool", name: "read", status: "running" });
          await params.opts?.onToolResult?.(media);
        },
        opts: {
          progressRequiresReply: true,
          suppressDefaultToolProgressMessages: true,
          onItemEvent,
        },
        onToolResult: onDurableToolResult,
      });
      await result.progress.drain();
      expect(onItemEvent).toHaveBeenCalledTimes(expectation !== "optional" ? 1 : 0);
      expect(onDurableToolResult).toHaveBeenCalledExactlyOnceWith(media);
    },
  );

  it("suppresses queued verbose-off preambles with only a static opt-in", async () => {
    const onItemEvent = vi.fn(async () => true as const);
    let preambleVisible: boolean | void = true;
    const turn = createTurn({
      session: createSession(() => ({ verboseLevel: "off" })),
    });
    const result = await executeTestTurn({
      turn,
      run: async (params) => {
        preambleVisible = await params.opts?.onItemEvent?.({
          kind: "preamble",
          progressText: "Checking the queued request",
        });
      },
      opts: { onItemEvent, commentaryPayloadsEnabled: true },
    });
    await result.progress.drain();

    expect(result.commentaryPayloadsEnabled).toBe(true);
    expect(preambleVisible).toBe(false);
    expect(onItemEvent).not.toHaveBeenCalled();
  });

  it.each(["allow", "deny"] as const)(
    "forwards quiet queued model waits only when delivery is allowed (%s)",
    async (sendPolicy) => {
      const turn = createTurn({ sendPolicy });
      turn.queued.originatingChannel = "feishu";
      turn.queued.run.messageProvider = "feishu";
      turn.queued.run.verboseLevelOverride = "off";
      const onItemEvent = vi.fn(async () => false as const);
      const events = [
        {
          kind: "model-wait",
          itemId: "model-wait",
          phase: "update",
          progressText: "Waiting for the local model to respond",
          suppressDurableProgress: true,
        },
        { kind: "model-wait", itemId: "model-wait", phase: "end", suppressDurableProgress: true },
      ] as const;
      const result = await executeTestTurn({
        turn,
        opts: { onItemEvent },
        run: async (params) => {
          for (const event of events) {
            await params.opts?.onItemEvent?.(event);
          }
          await params.opts?.onItemEvent?.({ kind: "tool", name: "read", status: "running" });
        },
      });
      await result.progress.drain();

      expect(onItemEvent.mock.calls).toEqual(
        sendPolicy === "allow" ? events.map((event) => [event]) : [],
      );
    },
  );

  it("keeps room-event progress, tool summaries, and typing silent", async () => {
    const turn = createTurn();
    turn.queued.currentInboundEventKind = "room_event";
    const typing = createTypingController();
    const onToolResult = vi.fn(async () => {});
    const onCompactionStart = vi.fn(async () => {});
    const onCompactionEnd = vi.fn(async () => {});
    const onReasoningEnd = vi.fn(async () => {});
    const onNarrationUpdate = vi.fn(async () => {});
    const result = await executeTestTurn({
      turn,
      run: async (params) => {
        await params.typingSignals.signalRunStart();
        await params.opts?.onToolResult?.({ text: "private progress" });
        await params.opts?.onCompactionStart?.();
        await params.opts?.onCompactionEnd?.();
        await params.opts?.onReasoningEnd?.();
        await params.opts?.onNarrationUpdate?.({ text: "private narration" });
      },
      defaults: {
        typing,
        typingMode: "instant",
        opts: {
          forceToolResultProgress: true,
          onCompactionStart,
          onCompactionEnd,
          onReasoningEnd,
          onNarrationUpdate,
        },
      },
      onToolResult,
    });
    await result.progress.drain();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
    expect(onCompactionStart).not.toHaveBeenCalled();
    expect(onCompactionEnd).not.toHaveBeenCalled();
    expect(onReasoningEnd).not.toHaveBeenCalled();
    expect(onNarrationUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["quiet", { verboseLevel: "off" }, false, false],
    [
      "source-suppressed",
      {
        callbackResult: true,
        sourceReplyDeliveryMode: "message_tool_only",
        opts: { allowProgressCallbacksWhenSourceDeliverySuppressed: true },
        payload: {
          text: "💨Fast: auto-off(75s>=60s)",
          channelData: { openclawProgressKind: "fast-mode-auto" },
        },
      },
      true,
      false,
    ],
    ["fallback", { callbackResult: false, opts: { forceToolResultProgress: true } }, true, true],
    [
      "disabled",
      {
        verboseLevel: "off",
        callbackResult: false,
        opts: {
          forceToolResultProgress: true,
          suppressToolProgressMessages: true,
          allowToolLifecycleWhenProgressHidden: true,
        },
      },
      false,
      false,
    ],
  ] as const)("routes %s queued fast-auto progress", async (_name, params, channel, durable) => {
    const { onChannelToolResult, onDurableToolResult, payload } =
      await runFastAutoProgressCase(params);
    expect(onChannelToolResult.mock.calls).toEqual(channel ? [[payload]] : []);
    expect(onDurableToolResult.mock.calls).toEqual(durable ? [[payload]] : []);
  });

  it("keeps lifecycle-only progress separate from generic summaries", async () => {
    const onToolStart = vi.fn(async () => true);
    const onItemEvent = vi.fn(async () => true);
    const onCommandOutput = vi.fn(async () => true);
    const onApprovalEvent = vi.fn(async () => true);
    const onPatchSummary = vi.fn(async () => true);
    const onChannelToolResult = vi.fn(async () => {});
    const onDurableToolResult = vi.fn(async () => {});
    const turn = createTurn();
    turn.queued.run.verboseLevelOverride = "off";
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      expect(params.shouldEmitToolResult()).toBe(false);
      expect(params.shouldEmitToolOutput()).toBe(false);
      expect(await params.opts?.onToolStart?.({ name: "read", phase: "start" })).toBe(true);
      expect(await params.opts?.onItemEvent?.({ kind: "tool", status: "blocked" })).toBe(false);
      expect(
        await params.opts?.onCommandOutput?.({ name: "exec", phase: "end", exitCode: 0 }),
      ).toBe(false);
      expect(await params.opts?.onApprovalEvent?.({ phase: "requested" })).toBe(false);
      expect(await params.opts?.onPatchSummary?.({ phase: "end", modified: ["file.ts"] })).toBe(
        false,
      );
      if (params.shouldEmitToolResult()) {
        await params.opts?.onToolResult?.({ text: "Generic summary" });
      }
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeTestTurn({
      turn,
      opts: {
        allowToolLifecycleWhenProgressHidden: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
        onApprovalEvent,
        onPatchSummary,
        onToolResult: onChannelToolResult,
      },
      onToolResult: onDurableToolResult,
    });
    await result.progress.drain();

    expect(onToolStart).toHaveBeenCalledOnce();
    for (const callback of [onItemEvent, onCommandOutput, onApprovalEvent, onPatchSummary]) {
      expect(callback).not.toHaveBeenCalled();
    }
    expect(onChannelToolResult).not.toHaveBeenCalled();
    expect(onDurableToolResult).not.toHaveBeenCalled();
  });
});

describe("executeFollowupTurn lifecycle", () => {
  it.each([
    { siblingReason: "rpc", cancelSurvivor: false },
    { siblingReason: "restart", cancelSurvivor: false },
    { siblingReason: "rpc", cancelSurvivor: true },
  ])(
    "isolates $siblingReason cancellation from runner defaults (cancel survivor: $cancelSurvivor)",
    async ({ siblingReason, cancelSurvivor }) => {
      const sibling = new AbortController();
      sibling.abort(
        siblingReason === "restart"
          ? createAgentRunRestartAbortError()
          : new Error("queued turn aborted: rpc"),
      );
      const survivor = new AbortController();
      const ownReason = new Error("survivor canceled");
      const turn = createTurn({
        operation: createMockReplyOperation({ abortSignal: survivor.signal }).replyOperation,
      });
      const entered = createDeferred();
      const release = createDeferred();
      const completed: AgentTurnExecutionResult = {
        runId: turn.runId,
        outcome: {
          kind: "settled",
          status: "ok",
          result: { meta: { durationMs: 0 } },
          resolved: { provider: "anthropic", model: "claude" },
          fallback: { exhausted: false, attempts: [] },
          autoCompactionCount: 0,
        },
      };
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        params.opts?.abortSignal?.throwIfAborted();
        entered.resolve();
        await release.promise;
        params.opts?.abortSignal?.throwIfAborted();
        return completed;
      });
      const pending = executeTestTurn({
        turn,
        opts: { abortSignal: sibling.signal },
      });
      try {
        await expect(
          awaitGateBeforeSettlement(entered.promise, pending, "survivor did not enter execution"),
        ).resolves.toBeUndefined();
        if (cancelSurvivor) {
          survivor.abort(ownReason);
        }
        release.resolve();
        if (cancelSurvivor) {
          await expect(pending).rejects.toBe(ownReason);
        } else {
          await expect(pending).resolves.toMatchObject({ execution: completed });
        }
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    },
  );

  it("drains detached progress before the caller can project a final", async () => {
    const order: string[] = [];
    const { promise: progressBarrier, resolve: releaseProgress } = createDeferred();
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      void params.opts?.onItemEvent?.({ progressText: "working" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    const result = await executeTestTurn({
      opts: {
        onItemEvent: async () => {
          await progressBarrier;
          order.push("progress");
        },
      },
    });
    const drain = result.progress.drain().then(() => order.push("drained"));
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseProgress();
    await drain;
    expect(order).toEqual(["progress", "drained"]);
  });

  it("preserves detached progress delivery failures for the drain", async () => {
    const failure = new Error("progress delivery failed");
    let detachedProgress!: Promise<unknown>;
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      detachedProgress = Promise.resolve(params.opts?.onItemEvent?.({ progressText: "working" }));
      void detachedProgress.catch(() => undefined);
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    const result = await executeTestTurn({
      opts: {
        onItemEvent: async () => {
          throw failure;
        },
      },
    });

    await expect(detachedProgress).resolves.toBe(false);
    await expect(result.progress.drain()).rejects.toBe(failure);
  });

  it("surfaces a failure after input acceptance without retrying before model start", async () => {
    const order: string[] = [];
    const { promise: progressBarrier, resolve: releaseProgress } = createDeferred();
    const failure = new Error("execution failed");
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      void params.opts?.onItemEvent?.({ progressText: "working" });
      throw failure;
    });
    const turn = createTurn();
    const onAdopted = vi.fn();
    turn.queued.turnAdoptionLifecycle = { onAdopted };
    const pending = executeTestTurn({
      turn,
      opts: {
        onItemEvent: async () => {
          await progressBarrier;
          order.push("progress");
        },
      },
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseProgress();
    await expect(pending).resolves.toMatchObject({
      execution: { outcome: { kind: "rejected", payload: { isError: true } } },
    });
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(state.execute).toHaveBeenCalledOnce();
    expect(order).toEqual(["progress"]);
  });

  it.each([
    { expectation: "required", progress: "none", accepted: false, visible: false },
    { expectation: "result-required", progress: "none", accepted: false, visible: false },
    { expectation: "optional", progress: "none", accepted: false, visible: false },
    { expectation: "optional", progress: "item", accepted: false, visible: false },
    { expectation: "optional", progress: "item", accepted: true, visible: true },
    { expectation: "optional", progress: "item", accepted: undefined, visible: true },
    { expectation: "optional", progress: "compaction", accepted: undefined, visible: true },
  ] as const)(
    "settles $expectation failure after $progress progress accepts $accepted",
    async ({ expectation, progress, accepted, visible }) => {
      const receipt: ReplyOperationRunState = {};
      const failure = new Error("execution failed after start");
      const { promise: progressBarrier, resolve: releaseProgress } = createDeferred();
      const { replyOperation: operation, failMock: fail } = createMockReplyOperation();
      const turn = createTurn({ operation });
      turn.queued.replyOperationRunStates = [receipt];
      turn.queued.run.terminalReplyExpectation = expectation;
      let observedVisibility: boolean | undefined;
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        markReplyOperationExecutionStarted(operation);
        if (progress === "item") {
          void params.opts?.onItemEvent?.({ progressText: "working" });
        } else if (progress === "compaction") {
          void params.onCompactionNoticePayload?.({ text: "Context compacted." });
        }
        observedVisibility = await params.resolveVisibleReplyDelivery?.();
        throw failure;
      });
      const pending = executeTestTurn({
        turn,
        opts: {
          onItemEvent: async () => {
            await progressBarrier;
            return accepted;
          },
        },
        onCompactionNoticePayload: async () => {
          await progressBarrier;
        },
      });
      await Promise.resolve();
      releaseProgress();
      const result = await pending;

      expect(observedVisibility).toBe(visible);
      expect(result.execution.outcome).toMatchObject({
        kind: "rejected",
        payload:
          visible || expectation !== "optional"
            ? { isError: true, text: expect.not.stringContaining("NO_REPLY") }
            : { text: "" },
      });
      expect(fail).toHaveBeenCalledWith("run_failed", failure);
      expect(resolveReplyOperationAgentTurn(receipt)).toBe("failed");
    },
  );

  it("waits for every pending task before propagating a drain failure", async () => {
    const failure = new Error("tool task failed");
    const { promise: slowBarrier, resolve: releaseSlowTask } = createDeferred();
    const order: string[] = [];
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      const failedTask = Promise.reject(failure).finally(() => {
        params.pendingToolTasks.delete(failedTask);
      });
      const slowTask = slowBarrier
        .then(() => {
          order.push("slow-finished");
        })
        .finally(() => {
          params.pendingToolTasks.delete(slowTask);
        });
      params.pendingToolTasks.add(failedTask);
      params.pendingToolTasks.add(slowTask);
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    const result = await executeTestTurn({});

    const drain = result.progress.drain();
    await Promise.resolve();
    releaseSlowTask();
    await expect(drain).rejects.toBe(failure);
    expect(order).toEqual(["slow-finished"]);
  });
});
