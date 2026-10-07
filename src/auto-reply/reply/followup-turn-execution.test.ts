import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnExecutionResult, AgentTurnParams } from "./agent-runner-execution.types.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import {
  createFollowupTurnTestTypingController,
  createFollowupTurnTestTurn,
  executeFollowupTurnForTest,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { resolveReplyOperationAgentTurn } from "./reply-operation-run-state.test-support.js";
import { markReplyOperationExecutionStarted } from "./reply-run-registry.state.js";
import { createMockReplyOperation } from "./test-helpers.js";

const state = getFollowupTurnTestState();
const createTypingController = createFollowupTurnTestTypingController;
const createTurn = createFollowupTurnTestTurn;
const executeFollowupTurn = executeFollowupTurnForTest;

beforeEach(resetFollowupTurnTestState);

type FollowupTurnParams = Parameters<typeof executeFollowupTurn>[0];

function executeTestTurn(
  params: Omit<FollowupTurnParams, "defaults" | "onToolResult" | "onCompactionNoticePayload"> &
    Partial<Pick<FollowupTurnParams, "onToolResult" | "onCompactionNoticePayload">> & {
      defaults?: Partial<FollowupTurnParams["defaults"]>;
    },
) {
  return executeFollowupTurn({
    ...params,
    defaults: {
      typing: createTypingController(),
      typingMode: "never",
      defaultModel: "claude",
      ...params.defaults,
    },
    onToolResult: params.onToolResult ?? vi.fn(async () => {}),
    onCompactionNoticePayload: params.onCompactionNoticePayload ?? vi.fn(async () => {}),
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
    session: {
      kind: "session",
      key: "main",
      current: () => ({
        sessionId: "session",
        updatedAt: 1,
        verboseLevel: params.verboseLevel ?? "on",
      }),
      publish: () => undefined,
      adopt: () => undefined,
    },
  });
  turn.queued.run.sourceReplyDeliveryMode = params.sourceReplyDeliveryMode;
  state.execute.mockImplementation(async (turnParams: AgentTurnParams) => {
    await turnParams.opts?.onToolResult?.(payload);
    return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
  });

  const result = await executeTestTurn({
    turn,
    defaults: {
      opts: {
        ...params.opts,
        onToolResult: onChannelToolResult,
      },
    },
    onToolResult: onDurableToolResult,
  });
  await result.progress.drain();
  return { onChannelToolResult, onDurableToolResult, payload };
}

describe("executeFollowupTurn", () => {
  it("refreshes the eligible queued turn from its current personal profile", async () => {
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        current: () => ({
          sessionId: "session",
          updatedAt: 2,
          createdActor: { type: "human", source: "profile", id: "creator" },
          owner: { actor: { type: "human", id: "new-owner" } },
        }),
        publish: () => undefined,
        adopt: () => undefined,
      },
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

  it("normalizes queued route facts into the canonical execution call", async () => {
    const turn = createTurn();
    const typing = createTypingController();
    const onAgentRunStart = vi.fn();
    turn.queued.runObservers = { onAgentRunStart };
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      params.opts?.onAgentRunStart?.("run-1");
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    await executeTestTurn({
      turn,
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

  it("ignores older verbosity from the admitted session generation", async () => {
    const currentEntry = {
      sessionId: "session",
      lifecycleRevision: "owned",
      updatedAt: 2,
      verboseLevel: "off" as const,
    };
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        storePath: "/tmp/sessions.json",
        current: () => currentEntry,
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.loadEntryReadOnly.mockReturnValue({
      ...currentEntry,
      updatedAt: 1,
      verboseLevel: "full",
    });

    await executeTestTurn({
      turn,
    });

    const call = state.execute.mock.calls[0]?.[0] as AgentTurnParams;
    expect(call.resolvedVerboseLevel).toBe("off");
  });

  it("refreshes awaited visibility without native reads or replacement-session verbosity", async () => {
    const entry = {
      sessionId: "session",
      lifecycleRevision: "owned",
      updatedAt: 1,
      verboseLevel: "off" as const,
    };
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        storePath: "/tmp/sessions.json",
        current: () => entry,
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    const legacy = vi.fn();
    await executeTestTurn({
      turn,
      defaults: {
        opts: {
          onVerboseProgressVisibility: legacy,
          onVerboseProgressVisibilityAsync: async (isActive) => {
            state.readEntry.mockResolvedValue(entry);
            expect(await isActive()).toBe(false);
            state.readEntry.mockResolvedValue({ ...entry, verboseLevel: "full" });
            expect(await isActive()).toBe(true);
            state.readEntry.mockResolvedValue({
              ...entry,
              lifecycleRevision: "replacement",
              verboseLevel: "full",
            });
            expect(await isActive()).toBe(false);
            expect(state.loadEntryReadOnly).not.toHaveBeenCalled();
          },
        },
      },
    });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("rejects awaited visibility when the followup is revoked during its read", async () => {
    const pending = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<void>();
    const abort = new AbortController();
    const turn = createTurn();
    turn.operation = { ...turn.operation, abortSignal: abort.signal };
    turn.session = {
      ...turn.session,
      kind: "session",
      key: "main",
      storePath: "/tmp/sessions.json",
    };
    state.readEntry.mockImplementation(() => {
      entered.resolve();
      return pending.promise;
    });
    const execution = executeTestTurn({
      turn,
      defaults: {
        opts: {
          onVerboseProgressVisibilityAsync: async (isActive) => {
            await isActive();
          },
        },
      },
    });
    const rejected = expect(execution).rejects.toThrow("followup revoked");
    await entered.promise;
    abort.abort(new Error("followup revoked"));
    pending.resolve(undefined);
    await rejected;
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("freezes commentary ownership for a queued on-to-off transition", async () => {
    let verboseLevel: "on" | "off" = "off";
    let isVerboseProgressActive = () => true;
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel }),
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      expect(params.resolvedVerboseLevel).toBe("off");
      expect(params.opts?.commentaryPayloadsEnabled).toBe(false);
      verboseLevel = "on";
      expect(isVerboseProgressActive()).toBe(false);
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeTestTurn({
      turn,
      defaults: {
        opts: {
          commentaryPayloadsEnabled: true,
          shouldDeliverCommentaryPayloads: () => isVerboseProgressActive(),
          onVerboseProgressVisibility: (getter) => {
            isVerboseProgressActive = getter;
          },
        },
      },
    });

    expect(result.commentaryPayloadsEnabled).toBe(false);
  });

  it("suppresses queued verbose-off preambles with only a static opt-in", async () => {
    const onItemEvent = vi.fn(async () => true as const);
    let preambleVisible: boolean | void = true;
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "off" }),
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      preambleVisible = await params.opts?.onItemEvent?.({
        kind: "preamble",
        progressText: "Checking the queued request",
      });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeTestTurn({
      turn,
      defaults: {
        opts: { onItemEvent, commentaryPayloadsEnabled: true },
      },
    });
    await result.progress.drain();

    expect(result.commentaryPayloadsEnabled).toBe(true);
    expect(preambleVisible).toBe(false);
    expect(onItemEvent).not.toHaveBeenCalled();
  });

  it("keeps room-event progress, tool summaries, and typing silent", async () => {
    const turn = createTurn({
      queued: { ...createTurn().queued, currentInboundEventKind: "room_event" },
    });
    const typing = createTypingController();
    const onToolResult = vi.fn(async () => {});
    const onCompactionStart = vi.fn(async () => {});
    const onCompactionEnd = vi.fn(async () => {});
    const onReasoningEnd = vi.fn(async () => {});
    const onNarrationUpdate = vi.fn(async () => {});
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.typingSignals.signalRunStart();
      await params.opts?.onToolResult?.({ text: "private progress" });
      await params.opts?.onCompactionStart?.();
      await params.opts?.onCompactionEnd?.();
      await params.opts?.onReasoningEnd?.();
      await params.opts?.onNarrationUpdate?.({ text: "private narration" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeTestTurn({
      turn,
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

  it("routes channel-forced tool progress through the channel when verbosity is off", async () => {
    const onToolStart = vi.fn(async () => {});
    const onChannelToolResult = vi.fn(async () => {});
    const onDurableToolResult = vi.fn(async () => {});
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "off" }),
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.opts?.onToolStart?.({ name: "read", phase: "start" });
      await params.opts?.onToolResult?.({ text: "Web Fetch: working" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeTestTurn({
      turn,
      defaults: {
        opts: {
          forceToolResultProgress: true,
          onToolStart,
          onToolResult: onChannelToolResult,
        },
      },
      onToolResult: onDurableToolResult,
    });
    await result.progress.drain();

    expect(onToolStart).toHaveBeenCalledOnce();
    expect(onChannelToolResult).toHaveBeenCalledWith({ text: "Web Fetch: working" });
    expect(onDurableToolResult).not.toHaveBeenCalled();
  });

  it("keeps queued fast auto progress hidden at verbosity off", async () => {
    const { onChannelToolResult, onDurableToolResult } = await runFastAutoProgressCase({
      verboseLevel: "off",
    });
    expect(onChannelToolResult).not.toHaveBeenCalled();
    expect(onDurableToolResult).not.toHaveBeenCalled();
  });

  it("lets an opted-in queued fast auto callback own source-suppressed delivery", async () => {
    const payload = {
      text: "💨Fast: auto-off(75s>=60s)",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload;
    const { onChannelToolResult, onDurableToolResult } = await runFastAutoProgressCase({
      callbackResult: true,
      sourceReplyDeliveryMode: "message_tool_only",
      opts: { allowProgressCallbacksWhenSourceDeliverySuppressed: true },
      payload,
    });
    expect(onChannelToolResult).toHaveBeenCalledOnce();
    expect(onChannelToolResult).toHaveBeenCalledWith(payload);
    expect(onDurableToolResult).not.toHaveBeenCalled();
  });

  it("falls back once when a queued forced fast auto callback declines visibility", async () => {
    const { onChannelToolResult, onDurableToolResult, payload } = await runFastAutoProgressCase({
      callbackResult: false,
      opts: { forceToolResultProgress: true },
    });
    expect(onChannelToolResult).toHaveBeenCalledOnce();
    expect(onChannelToolResult).toHaveBeenCalledWith(payload);
    expect(onDurableToolResult).toHaveBeenCalledOnce();
    expect(onDurableToolResult).toHaveBeenCalledWith(payload);
  });

  it("suppresses queued fast auto callbacks when tool progress is disabled", async () => {
    const { onChannelToolResult, onDurableToolResult } = await runFastAutoProgressCase({
      verboseLevel: "off",
      callbackResult: false,
      opts: {
        forceToolResultProgress: true,
        suppressToolProgressMessages: true,
        allowToolLifecycleWhenProgressHidden: true,
      },
    });
    expect(onChannelToolResult).not.toHaveBeenCalled();
    expect(onDurableToolResult).not.toHaveBeenCalled();
  });

  it("keeps quiet forced ask-user prompts on the durable path", async () => {
    const payload = {
      text: "Question for you: Where should this deploy?",
      channelData: { askUser: { questionId: "question-owned-by-agent-runtime" } },
    } satisfies ReplyPayload;

    const onChannelToolResult = vi.fn(async () => {});
    const onDurableToolResult = vi.fn(async () => {});
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "off" }),
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.opts?.onToolResult?.(payload);
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeTestTurn({
      turn,
      defaults: {
        opts: {
          forceToolResultProgress: true,
          onToolResult: onChannelToolResult,
        },
      },
      onToolResult: onDurableToolResult,
    });
    await result.progress.drain();

    expect(onChannelToolResult).not.toHaveBeenCalled();
    expect(onDurableToolResult).toHaveBeenCalledOnce();
    expect(onDurableToolResult).toHaveBeenCalledWith(payload);
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
      defaults: {
        opts: {
          allowToolLifecycleWhenProgressHidden: true,
          onToolStart,
          onItemEvent,
          onCommandOutput,
          onApprovalEvent,
          onPatchSummary,
          onToolResult: onChannelToolResult,
        },
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
          didLogHeartbeatStrip: false,
        },
      };
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        params.opts?.abortSignal?.throwIfAborted();
        entered.resolve();
        await release.promise;
        params.opts?.abortSignal?.throwIfAborted();
        return completed;
      });
      const pending = executeFollowupTurn({
        turn,
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: { abortSignal: sibling.signal },
        },
        onToolResult: vi.fn(async () => {}),
        onCompactionNoticePayload: vi.fn(async () => {}),
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
    const result = await executeFollowupTurn({
      turn: createTurn(),
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: {
          onItemEvent: async () => {
            await progressBarrier;
            order.push("progress");
          },
        },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
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
    const result = await executeFollowupTurn({
      turn: createTurn(),
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: {
          onItemEvent: async () => {
            throw failure;
          },
        },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    await expect(detachedProgress).resolves.toBe(false);
    await expect(result.progress.drain()).rejects.toBe(failure);
  });

  it("drains detached progress before propagating execution failure", async () => {
    const order: string[] = [];
    const { promise: progressBarrier, resolve: releaseProgress } = createDeferred();
    const failure = new Error("execution failed");
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      void params.opts?.onItemEvent?.({ progressText: "working" });
      throw failure;
    });
    const pending = executeFollowupTurn({
      turn: createTurn(),
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: {
          onItemEvent: async () => {
            await progressBarrier;
            order.push("progress");
          },
        },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseProgress();
    await expect(pending).rejects.toBe(failure);
    expect(order).toEqual(["progress"]);
  });

  it.each([
    { expectation: "required", progress: "none", accepted: false, visible: false },
    { expectation: "optional", progress: "item", accepted: false, visible: false },
    { expectation: "optional", progress: "compaction", accepted: undefined, visible: true },
  ] as const)(
    "settles $expectation failure after $progress progress accepts $accepted",
    async ({ expectation, progress, accepted, visible }) => {
      const receipt: ReplyOperationRunState = {};
      const failure = new Error("execution failed after start");
      const { promise: progressBarrier, resolve: releaseProgress } = createDeferred();
      const fail = vi.fn();
      const operation = {
        ...createMockReplyOperation().replyOperation,
        fail,
      } as unknown as AdmittedFollowupTurn["operation"];
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
      const pending = executeFollowupTurn({
        turn,
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: {
            onItemEvent: async () => {
              await progressBarrier;
              return accepted;
            },
          },
        },
        onToolResult: vi.fn(async () => {}),
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
          visible || expectation === "required"
            ? { isError: true, text: expect.not.stringContaining("NO_REPLY") }
            : { text: "NO_REPLY" },
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
    const result = await executeFollowupTurn({
      turn: createTurn(),
      defaults: { typing: createTypingController(), typingMode: "never", defaultModel: "claude" },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    const drain = result.progress.drain();
    await Promise.resolve();
    releaseSlowTask();
    await expect(drain).rejects.toBe(failure);
    expect(order).toEqual(["slow-finished"]);
  });
});
