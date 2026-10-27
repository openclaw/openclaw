import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { markReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";
import { expectNoCalls } from "../../test-utils/mock-call-assertions.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { AgentTurnExecutionResult, AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createFollowupTurnTestTurn as createTurn,
  executeFollowupTurnForTest as executeFollowupTurn,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { resolveReplyOperationAgentTurn } from "./reply-operation-run-state.test-support.js";
import { createMockReplyOperation, createMockTypingController } from "./test-helpers.js";

const state = getFollowupTurnTestState();
function mockExecution(run: (params: AgentTurnParams) => void | Promise<void>) {
  state.execute.mockImplementation(async (params: AgentTurnParams) => {
    await run(params);
    return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
  });
}

function sessionTurn(current: NonNullable<AdmittedFollowupTurn["session"]["current"]>) {
  return createTurn({ session: { kind: "session", key: "main", current, publish: () => {} } });
}

beforeEach(resetFollowupTurnTestState);

type FollowupTurnParams = Parameters<typeof executeFollowupTurn>[0];

function executeTestTurn(
  params: Omit<FollowupTurnParams, "defaults" | "onToolResult" | "onCompactionNoticePayload"> &
    Partial<Pick<FollowupTurnParams, "onToolResult" | "onCompactionNoticePayload">> & {
      defaults?: Partial<FollowupTurnParams["defaults"]>;
      opts?: FollowupTurnParams["defaults"]["opts"];
    },
) {
  return executeFollowupTurn({
    ...params,
    defaults: {
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "claude",
      ...params.defaults,
      ...(params.opts ? { opts: params.opts } : {}),
    },
    onToolResult: params.onToolResult ?? vi.fn(async () => {}),
    onCompactionNoticePayload: params.onCompactionNoticePayload ?? vi.fn(async () => {}),
  });
}

describe("executeFollowupTurn", () => {
  it("retains the queued turn's restart restrictions over later runner defaults", async () => {
    const turn = createTurn();
    turn.queued.forceRestartSafeTools = true;
    turn.queued.forceCodeModeTools = true;
    await executeTestTurn({
      turn,
      defaults: { opts: { forceRestartSafeTools: false, forceCodeModeTools: false } },
    });
    expect(state.execute.mock.calls[0]?.[0]?.opts).toMatchObject({
      forceRestartSafeTools: true,
      forceCodeModeTools: true,
    });
  });

  it("records preflight failure on source receipts without changing newer runner state", async () => {
    const receipts: ReplyOperationRunState[] = [{}, {}];
    const newerReceipt: ReplyOperationRunState = {};
    const turn = createTurn();
    turn.queued.replyOperationRunStates = receipts;
    turn.preflightFailurePayload = { text: "preflight failed" };

    await executeTestTurn({
      turn,
      defaults: {
        opts: { [REPLY_OPERATION_RUN_STATE]: newerReceipt },
      },
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

  it("notifies the queued observer when execution starts", async () => {
    const turn = createTurn();
    const onAgentRunStart = vi.fn();
    turn.queued.runObservers = { onAgentRunStart };
    mockExecution((params) => {
      params.opts?.onAgentRunStart?.("run-1");
    });

    await executeTestTurn({ turn });
    expect(onAgentRunStart).toHaveBeenCalledWith("run-1");
  });

  it("uses turn-owned preference updates for awaited visibility", async () => {
    let verboseLevel: "off" | "full" = "off";
    const turn = sessionTurn(() => ({ sessionId: "session", updatedAt: 1, verboseLevel }));
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
    const turn = sessionTurn(() => ({ sessionId: "session", updatedAt: 1, verboseLevel }));
    mockExecution(() => {
      verboseLevel = "on";
      expect(isVerboseProgressActive()).toBe(false);
    });

    const result = await executeTestTurn({
      turn,
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
      mockExecution(async (params) => {
        await params.opts?.onItemEvent?.({ kind: "tool", name: "read", status: "running" });
        await params.opts?.onToolResult?.(media);
      });
      const result = await executeTestTurn({
        turn,
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
    const turn = sessionTurn(() => ({ sessionId: "session", updatedAt: 1, verboseLevel: "off" }));
    mockExecution(async (params) => {
      preambleVisible = await params.opts?.onItemEvent?.({
        kind: "preamble",
        progressText: "Checking the queued request",
      });
    });

    const result = await executeTestTurn({
      turn,
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
      mockExecution(async (params) => {
        for (const event of events) {
          await params.opts?.onItemEvent?.(event);
        }
        await params.opts?.onItemEvent?.({ kind: "tool", name: "read", status: "running" });
      });

      const result = await executeTestTurn({ turn, opts: { onItemEvent } });
      await result.progress.drain();

      expect(onItemEvent).toHaveBeenCalledTimes(sendPolicy === "allow" ? 2 : 0);
      if (sendPolicy === "allow") {
        expect(onItemEvent).toHaveBeenNthCalledWith(1, events[0]);
        expect(onItemEvent).toHaveBeenNthCalledWith(2, events[1]);
      }
    },
  );

  it("keeps room-event progress, tool summaries, and typing silent", async () => {
    const turn = createTurn({
      queued: { ...createTurn().queued, currentInboundEventKind: "room_event" },
    });
    const typing = createMockTypingController();
    const callbacks = {
      onCompactionStart: vi.fn(async () => {}),
      onCompactionEnd: vi.fn(async () => {}),
      onReasoningEnd: vi.fn(async () => {}),
      onNarrationUpdate: vi.fn(async () => {}),
    };
    const onToolResult = vi.fn(async () => {});
    mockExecution(async (params) => {
      await params.typingSignals.signalRunStart();
      await params.opts?.onToolResult?.({ text: "private progress" });
      await params.opts?.onCompactionStart?.();
      await params.opts?.onCompactionEnd?.();
      await params.opts?.onReasoningEnd?.();
      await params.opts?.onNarrationUpdate?.({ text: "private narration" });
    });

    const result = await executeTestTurn({
      turn,
      defaults: {
        typing,
        typingMode: "instant",
        opts: {
          forceToolResultProgress: true,
          ...callbacks,
        },
      },
      onToolResult,
    });
    await result.progress.drain();

    expectNoCalls(
      typing.startTypingLoop,
      typing.startTypingOnText,
      onToolResult,
      ...Object.values(callbacks),
    );
  });

  it.each<[string, "on" | "off", GetReplyOptions, boolean | undefined, [boolean, boolean]]>([
    ["hidden at verbosity off", "off", {}, undefined, [false, false]],
    [
      "callback owns source-suppressed delivery",
      "on",
      {
        sourceReplyDeliveryMode: "message_tool_only",
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
      },
      true,
      [true, false],
    ],
    [
      "declined callback falls back once",
      "on",
      { forceToolResultProgress: true },
      false,
      [true, true],
    ],
    [
      "explicit suppression hides callbacks",
      "off",
      {
        forceToolResultProgress: true,
        suppressToolProgressMessages: true,
        allowToolLifecycleWhenProgressHidden: true,
      },
      false,
      [false, false],
    ],
  ])("queued fast auto progress: %s", async (_name, verboseLevel, opts, accepted, deliveries) => {
    const payload = {
      text: "💨Fast: auto-on",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload;
    const onChannelToolResult = vi.fn(() => accepted);
    const onDurableToolResult = vi.fn(async () => {});
    const turn = sessionTurn(() => ({ sessionId: "session", updatedAt: 1, verboseLevel }));
    const { sourceReplyDeliveryMode, ...progressOpts } = opts;
    turn.queued.run.sourceReplyDeliveryMode = sourceReplyDeliveryMode;
    mockExecution(async (params) => {
      await params.opts?.onToolResult?.(payload);
    });
    const result = await executeTestTurn({
      turn,
      opts: { ...progressOpts, onToolResult: onChannelToolResult },
      onToolResult: onDurableToolResult,
    });
    await result.progress.drain();
    expect([onChannelToolResult.mock.calls, onDurableToolResult.mock.calls]).toEqual(
      deliveries.map((delivered) => (delivered ? [[payload]] : [])),
    );
  });

  it("keeps lifecycle-only progress separate from generic summaries", async () => {
    const onToolStart = vi.fn(async () => true);
    const hiddenCallbacks = {
      onItemEvent: vi.fn(async () => true),
      onCommandOutput: vi.fn(async () => true),
      onApprovalEvent: vi.fn(async () => true),
      onPatchSummary: vi.fn(async () => true),
    };
    const onChannelToolResult = vi.fn(async () => {});
    const onDurableToolResult = vi.fn(async () => {});
    const turn = createTurn();
    turn.queued.run.verboseLevelOverride = "off";
    mockExecution(async (params) => {
      expect([
        params.shouldEmitToolResult(),
        params.shouldEmitToolOutput(),
        await params.opts?.onToolStart?.({ name: "read", phase: "start" }),
        await params.opts?.onItemEvent?.({ kind: "tool", status: "blocked" }),
        await params.opts?.onCommandOutput?.({ name: "exec", phase: "end", exitCode: 0 }),
        await params.opts?.onApprovalEvent?.({ phase: "requested" }),
        await params.opts?.onPatchSummary?.({ phase: "end", modified: ["file.ts"] }),
      ]).toEqual([false, false, true, false, false, false, false]);
      if (params.shouldEmitToolResult()) {
        await params.opts?.onToolResult?.({ text: "Generic summary" });
      }
    });

    const result = await executeTestTurn({
      turn,
      opts: {
        allowToolLifecycleWhenProgressHidden: true,
        onToolStart,
        ...hiddenCallbacks,
        onToolResult: onChannelToolResult,
      },
      onToolResult: onDurableToolResult,
    });
    await result.progress.drain();

    expect(onToolStart).toHaveBeenCalledOnce();
    expectNoCalls(...Object.values(hiddenCallbacks), onChannelToolResult, onDurableToolResult);
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
        outcome: { kind: "rejected", payload: { text: "done" } },
      };
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        params.opts?.abortSignal?.throwIfAborted();
        entered.resolve();
        await release.promise;
        params.opts?.abortSignal?.throwIfAborted();
        return completed;
      });
      const pending = executeTestTurn({ turn, opts: { abortSignal: sibling.signal } });
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
    const gate = createDeferred();
    const order: string[] = [];
    mockExecution((params) => {
      void params.opts?.onItemEvent?.({ progressText: "working" });
    });
    const result = await executeTestTurn({
      turn: createTurn(),
      opts: {
        onItemEvent: async () => {
          await gate.promise;
          order.push("progress");
        },
      },
    });
    const drain = result.progress.drain().then(() => order.push("drained"));
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.resolve();
    await drain;
    expect(order).toEqual(["progress", "drained"]);
  });

  it("preserves detached progress delivery failures for the drain", async () => {
    const failure = new Error("progress delivery failed");
    let detachedProgress!: Promise<unknown>;
    mockExecution((params) => {
      detachedProgress = Promise.resolve(params.opts?.onItemEvent?.({ progressText: "working" }));
      void detachedProgress.catch(() => undefined);
    });
    const result = await executeTestTurn({
      turn: createTurn(),
      opts: {
        onItemEvent: async () => {
          throw failure;
        },
      },
    });

    await expect(detachedProgress).resolves.toBe(false);
    await expect(result.progress.drain()).rejects.toBe(failure);
  });

  it.each([
    ["required", "item", undefined, true, true],
    ["required", "none", false, false, false],
    ["result-required", "none", false, false, false],
    ["optional", "none", false, false, false],
    ["optional", "item", false, false, false],
    ["optional", "item", true, true, false],
    ["optional", "item", undefined, true, false],
    ["optional", "compaction", undefined, true, false],
  ] as const)(
    "settles %s failure after %s progress accepts %s (visible: %s, before start: %s)",
    async (expectation, progress, accepted, visible, beforeStart) => {
      const receipt: ReplyOperationRunState = {};
      const failure = new Error("execution failed after start");
      const { promise: progressBarrier, resolve: releaseProgress } = createDeferred();
      const { replyOperation: operation, failMock: fail } = createMockReplyOperation();
      const turn = createTurn({ operation });
      const onAdopted = vi.fn();
      turn.queued.turnAdoptionLifecycle = { onAdopted };
      turn.queued.replyOperationRunStates = [receipt];
      turn.queued.run.terminalReplyExpectation = expectation;
      let observedVisibility: boolean | undefined;
      let completedProgress = false;
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        if (!beforeStart) {
          markReplyOperationExecutionStarted(operation);
        }
        if (progress === "item") {
          void params.opts?.onItemEvent?.({ progressText: "working" });
        } else if (progress === "compaction") {
          void params.onCompactionNoticePayload?.({ text: "Context compacted." });
        }
        if (!beforeStart) {
          observedVisibility = await params.resolveVisibleReplyDelivery?.();
        }
        throw failure;
      });
      const pending = executeTestTurn({
        turn,
        opts: {
          onItemEvent: async () => {
            await progressBarrier;
            completedProgress = true;
            return accepted;
          },
        },
        onCompactionNoticePayload: async () => {
          await progressBarrier;
          completedProgress = true;
        },
      });
      await Promise.resolve();
      expect(completedProgress).toBe(false);
      releaseProgress();
      const result = await pending;

      expect(observedVisibility).toBe(beforeStart ? undefined : visible);
      expect(completedProgress).toBe(progress !== "none");
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(state.execute).toHaveBeenCalledOnce();
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
    mockExecution((params) => {
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
    });
    const result = await executeTestTurn({ turn: createTurn() });

    const drain = result.progress.drain();
    await Promise.resolve();
    releaseSlowTask();
    await expect(drain).rejects.toBe(failure);
    expect(order).toEqual(["slow-finished"]);
  });
});
