import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  resolveSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "../../config/sessions/session-transcript-read-fence.js";
import { createChatSendLateFollowupDisposition } from "../../gateway/server-methods/chat-send-late-followup.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import type { FollowupRun } from "./queue.js";
import type { QueuedFollowupReplyBatch } from "./queue/types.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import { createMockTypingController } from "./test-helpers.js";

const state = vi.hoisted(() => ({
  account: vi.fn(),
  admit: vi.fn(),
  completeLifecycle: vi.fn(),
  completedSourceDelivery: false,
  deliver: vi.fn(),
  execute: vi.fn(),
  resolveDecision: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-runner/delivery-evidence.js", () => ({
  hasCompletedSourceReplyDeliveryEvidence: () => state.completedSourceDelivery,
}));

vi.mock("./agent-runner-result-accounting.js", () => ({
  accountFollowupTurn: (...args: unknown[]) => state.account(...args),
}));

vi.mock("./reply-agent-turn-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-agent-turn-preparation.js")>()),
  prepareReplyAgentTurn: (...args: unknown[]) => state.admit(...args),
}));

// mock-isolation: Presentation tests use synthetic operations; real owner admission is
// exercised by followup-runner.queue-custody.test.ts through the production runner.
vi.mock("./reply-turn-admission-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-turn-admission-lifecycle.js")>()),
  runWithReplyOperationLifecycleAdmission: async (
    _operation: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));

vi.mock("./followup-turn-execution.js", () => ({
  executeFollowupTurn: (...args: unknown[]) => state.execute(...args),
}));

vi.mock("./followup-delivery.js", () => ({
  deliverFollowupDecision: (...args: unknown[]) => state.deliver(...args),
  resolveFollowupDeliveryDecision: (...args: unknown[]) => state.resolveDecision(...args),
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  completeFollowupRunLifecycle: (...args: unknown[]) => state.completeLifecycle(...args),
}));

vi.mock("../../runtime.js", () => ({ defaultRuntime: { error: vi.fn() } }));

const { createFollowupRunner } = await import("./followup-runner.js");
let turn: ReturnType<typeof createTurn>;
let typing: ReturnType<typeof createMockTypingController>;

function createRunner(overrides: Partial<Parameters<typeof createFollowupRunner>[0]> = {}) {
  return createFollowupRunner({
    typing,
    typingMode: "never",
    defaultModel: "claude",
    ...overrides,
  });
}

function admitTurn(admitted: ReturnType<typeof createTurn>, execution = createSettledExecution()) {
  state.admit.mockResolvedValue({ kind: "admitted", turn: admitted });
  state.execute.mockResolvedValue(execution);
}

function attachSource(source: ReturnType<typeof createTurn>) {
  const deliver = vi.fn(async () => {});
  source.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
  return deliver;
}

function expectTypingComplete() {
  expect(typing.markRunComplete).toHaveBeenCalledOnce();
  expect(typing.markDispatchIdle).toHaveBeenCalledOnce();
}

function createQueuedRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
}

function createTurn(
  order: string[] = [],
  result: AdmittedFollowupTurn["operation"]["result"] = null,
) {
  const operation = {
    result,
    complete: vi.fn(() => order.push("operation-complete")),
    fail: vi.fn(() => order.push("operation-failed")),
  };
  return {
    runId: "run-1",
    queued: createQueuedRun(),
    operation,
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => undefined,
      publish: vi.fn(),
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  } as unknown as AdmittedFollowupTurn & { operation: typeof operation };
}

function createRejectedExecution(order: string[] = []): FollowupExecutionResult {
  return {
    commentaryPayloadsEnabled: false,
    execution: {
      runId: "run-1",
      outcome: { kind: "rejected", payload: { text: "failed" } },
    },
    runStartedAt: 1,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: {
      drain: vi.fn(async () => {
        order.push("progress-drained");
      }),
    },
  } as FollowupExecutionResult;
}

function createSettledExecution(): FollowupExecutionResult {
  return {
    ...createRejectedExecution(),
    execution: {
      runId: "run-1",
      outcome: {
        kind: "settled",
        status: "ok",
        result: { payloads: [], meta: { durationMs: 0 } },
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        autoCompactionCount: 0,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  turn = createTurn();
  typing = createMockTypingController();
  admitTurn(turn);
  state.completedSourceDelivery = false;
  state.account.mockResolvedValue(undefined);
  state.resolveDecision.mockReturnValue({ kind: "suppress", reason: "silent" });
  state.deliver.mockResolvedValue({ kind: "completed", payloads: [] });
});

describe("createFollowupRunner", () => {
  it.each([
    { kind: "pending", failed: false },
    { kind: "pending", failed: true },
    { kind: "source-retry", failed: false },
    { kind: "source-retry", failed: true },
  ] as const)(
    "distinguishes transport handoff from source retry ($kind, failed=$failed)",
    async ({ kind, failed }) => {
      const end = vi.fn();
      turn.queued.deliveryCorrelations = [{ begin: () => end }];
      state.admit.mockResolvedValue({ kind: "admitted", turn });
      state.execute.mockResolvedValue(
        failed ? createRejectedExecution() : createSettledExecution(),
      );
      state.deliver.mockResolvedValue({ kind, payloads: [] });

      await createRunner()(turn.queued);

      expect(end).toHaveBeenCalledExactlyOnceWith(
        kind === "source-retry" && !failed
          ? undefined
          : {
              visibleReplySent: false,
              failed,
              completed: !failed,
              ...(kind === "pending" ? { transportPending: true } : {}),
            },
      );
    },
  );

  it("reads the current transcript without borrowing the interrupted turn's admission fence", async () => {
    const admission = {
      agentId: "agent",
      sessionId: "session",
      sessionKey: "main",
      storePath: "/tmp/store",
      generation: "generation",
      entryId: "interrupted-user-message",
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 1,
      logicalTurnId: "interrupted-turn",
      role: "user" as const,
    };
    state.admit.mockImplementation(async () => {
      expect(resolveSessionTranscriptReadFence(admission)).toBeUndefined();
      return { kind: "admitted", turn };
    });
    state.execute.mockImplementation(async () => {
      await Promise.resolve();
      expect(resolveSessionTranscriptReadFence(admission)).toBeUndefined();
      return createSettledExecution();
    });
    await runWithSessionTranscriptReadFence(admission, async () => {
      await createRunner()(turn.queued);
      expect(resolveSessionTranscriptReadFence(admission)).toBe(admission);
    });
  });

  it.each([
    { channel: "webchat", phase: "end", succeeds: true },
    { channel: "webchat", phase: "end", succeeds: false },
    { channel: "discord", phase: "start", succeeds: true },
  ] as const)(
    "delivers $channel compaction $phase at its owner boundary (admitted=$succeeds)",
    async ({ channel, phase, succeeds }) => {
      turn.queued.originatingChannel = channel;
      if (channel === "webchat") {
        const source = createChatSendLateFollowupDisposition({
          runId: "source-run",
          originatingChannel: channel,
          logGateway: { info: vi.fn() } as never,
          deliver: async () => ({ kind: "delivered" }),
        });
        source.recordQueued();
        turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: source.deliver };
      }
      const failure = new Error("session generation changed after compaction");
      const notice = {
        text: phase === "start" ? "Compacting context" : "Context compacted",
        replyToCurrent: true,
        isCompactionNotice: true,
      };
      const order: string[] = [];
      state.admit.mockImplementation(
        async (
          params: Parameters<
            typeof import("./reply-agent-turn-preparation.js").prepareReplyAgentTurn
          >[0],
        ) => {
          await params.onCompactionNotice?.(phase, notice.text, turn);
          if (!succeeds) {
            throw failure;
          }
          order.push("compaction-finished");
          return { kind: "admitted", turn };
        },
      );
      state.execute.mockImplementation(async () => {
        order.push("execution-settled");
        return createSettledExecution();
      });
      state.deliver.mockImplementation(async (params: { kind?: string }) => {
        order.push(params.kind === "block" ? "notice-delivered" : "final-delivered");
        return { kind: "completed", payloads: [] };
      });
      const run = createRunner()(turn.queued);
      if (!succeeds) {
        await expect(run).rejects.toBe(failure);
        expect(state.execute).not.toHaveBeenCalled();
        expect(state.deliver).not.toHaveBeenCalled();
        expect(state.completeLifecycle).not.toHaveBeenCalled();
        return;
      }
      await run;
      expect(order).toEqual(
        channel === "webchat"
          ? ["compaction-finished", "execution-settled", "notice-delivered", "final-delivered"]
          : ["notice-delivered", "compaction-finished", "execution-settled", "final-delivered"],
      );
      if (channel === "webchat") {
        expect(state.deliver).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            kind: "block",
            decision: { kind: "deliver", payloads: [notice] },
            runId: turn.runId,
          }),
        );
      }
    },
  );

  it("closes the current run once after transferring source delivery to recovery", async () => {
    const deliver = attachSource(turn);
    state.resolveDecision.mockReturnValue({
      kind: "retry-source-delivery",
      run: turn.queued,
      finalTextLength: 300,
      resolved: { provider: "anthropic", model: "claude" },
    });
    state.deliver.mockResolvedValue({ kind: "source-retry" });

    await createRunner()(turn.queued);

    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: turn.runId,
        completion: { kind: "completed" },
        payloads: [],
      }),
    );
  });

  it.each(["silent", "send-policy"] as const)(
    "settles the queued source when final delivery is suppressed by %s",
    async (reason) => {
      const deliver = attachSource(turn);
      const execution = createSettledExecution();
      admitTurn(turn, execution);
      state.resolveDecision.mockReturnValue({ kind: "suppress", reason });

      await createRunner()(turn.queued);

      expect(deliver).toHaveBeenCalledExactlyOnceWith({
        kind: "queued-followup",
        runId: turn.runId,
        originatingChannel: undefined,
        payloads: [],
        completion: {
          kind: "completed",
          ...(reason === "silent" ? { allowCanvasOnly: true } : {}),
        },
      });
    },
  );

  it.each(["timeout", "user", "restart"] as const)(
    "preserves %s classification when the queue owns completion",
    async (reason) => {
      const deliver = attachSource(turn);
      const execution = createSettledExecution();
      if (reason === "timeout" && execution.execution.outcome.kind === "settled") {
        execution.execution.outcome = {
          ...execution.execution.outcome,
          status: "failed",
          terminalFailurePayload: { text: "Provider timed out", isError: true },
          result: {
            payloads: [],
            meta: {
              durationMs: 1000,
              timeoutPhase: "provider",
              stopReason: "timeout",
              aborted: true,
              providerStarted: true,
            },
          },
        };
      } else if (reason !== "timeout") {
        execution.execution.outcome = { kind: "aborted", reason };
      }
      admitTurn(turn, execution);

      await createRunner()(turn.queued);

      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          completion:
            reason === "timeout"
              ? {
                  kind: "failed",
                  error: "Provider timed out",
                  stopReason: "timeout",
                  errorKind: "timeout",
                }
              : { kind: "aborted", stopReason: reason === "user" ? "aborted" : reason },
        }),
      );
    },
  );

  it("retains its Gateway and drops caller authority through the delivery retry handoff", async () => {
    const resolveGatewayContext = () => undefined;
    const otherGatewayContext = () => undefined;
    const staleAuthority = vi.fn();
    const observed: unknown[] = [];
    let retry: ((queued: FollowupRun) => Promise<void>) | undefined;
    state.admit.mockImplementation(async () => {
      const scope = getPluginRuntimeGatewayRequestScope();
      observed.push({
        resolver: scope?.resolveGatewayContext,
        authority: scope?.assertNodeExecutionCurrent,
      });
      return { kind: "admitted", turn };
    });
    state.execute.mockResolvedValue(createRejectedExecution());
    state.deliver
      .mockResolvedValue({ kind: "completed", payloads: [] })
      .mockImplementationOnce(
        async (
          params: Parameters<typeof import("./followup-delivery.js").deliverFollowupDecision>[0],
        ) => {
          retry = params.runFollowup;
          return { kind: "source-retry" };
        },
      );
    const run = createRunner({ resolveGatewayContext, typingMode: "instant" });
    await withPluginRuntimeGatewayRequestScope(
      {
        resolveGatewayContext: otherGatewayContext,
        assertNodeExecutionCurrent: staleAuthority,
        isWebchatConnect: () => false,
      },
      async () => {
        await run(turn.queued);
        if (!retry) {
          throw new Error("expected delivery retry callback");
        }
        await retry(turn.queued);
      },
    );
    expect(observed).toEqual([
      { resolver: resolveGatewayContext, authority: undefined },
      { resolver: resolveGatewayContext, authority: undefined },
    ]);
    expect(state.execute).toHaveBeenCalledTimes(2);
  });

  it.each(["already-aborted", "unowned skip", "owned skip"] as const)(
    "settles terminal input without execution (%s)",
    async (kind) => {
      const end = vi.fn();
      turn.queued.deliveryCorrelations = [{ begin: () => end }];
      if (kind === "already-aborted") {
        turn.queued.abortSignal = AbortSignal.abort();
      } else {
        state.admit.mockResolvedValue({
          kind: "skipped",
          reason: "lifecycle-invalidated",
          ...(kind === "owned skip" ? { operation: turn.operation } : {}),
        });
      }
      await expect(
        createRunner({ typing, typingMode: "instant" })(turn.queued),
      ).resolves.toBeUndefined();
      if (kind === "already-aborted") {
        expect(state.admit).not.toHaveBeenCalled();
      }
      expect(state.execute).not.toHaveBeenCalled();
      expect(turn.operation.complete).toHaveBeenCalledTimes(kind === "owned skip" ? 1 : 0);
      expectTypingComplete();
      expect(end).toHaveBeenCalledExactlyOnceWith({
        visibleReplySent: false,
        failed: true,
        completed: false,
      });
    },
  );

  it("consumes a user abort before execution starts", async () => {
    turn = createTurn([], { kind: "aborted", code: "aborted_by_user" });
    const deliver = attachSource(turn);
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockRejectedValue(new Error("aborted before execution start"));

    await createRunner({ typing, typingMode: "instant" })(turn.queued);

    expect(turn.operation.fail).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        completion: { kind: "aborted", stopReason: "aborted" },
        payloads: [],
      }),
    );
  });

  it("consumes revoked operator input instead of retrying a pre-execution refusal", async () => {
    const failure = new Error("original operator role changed");
    turn.queued.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.write"],
      assertCurrent: () => {
        throw failure;
      },
    });
    state.admit.mockRejectedValueOnce(failure);

    await expect(
      createRunner({ typing, typingMode: "never" })(turn.queued),
    ).resolves.toBeUndefined();

    expect(state.execute).not.toHaveBeenCalled();
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    expect(typing.markRunComplete).toHaveBeenCalledOnce();
  });

  it("does not replay a settled execution after progress presentation fails", async () => {
    const failure = new Error("progress presentation failed");
    const execution = createSettledExecution();
    const deliver = attachSource(turn);
    admitTurn(turn, execution);
    execution.progress.drain = vi.fn(async () => {
      throw failure;
    });
    await createRunner({ typingMode: "instant" })(turn.queued);
    expect(state.execute).toHaveBeenCalledOnce();
    expect(turn.operation.fail).toHaveBeenCalledWith("run_failed", failure);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        completion: { kind: "failed", error: failure.message },
        payloads: [],
      }),
    );
  });

  it("holds the reply operation through progress drain, accounting, and delivery", async () => {
    const order: string[] = [];
    turn = createTurn(order);
    const execution = createRejectedExecution(order);
    const sourceDelivery = vi.fn(async () => {
      order.push("completion");
    });
    const presentationGate = createDeferred();
    const presentationStarted = createDeferred();
    const endCorrelation = vi.fn();
    turn.queued.deliveryCorrelations = [{ begin: () => endCorrelation }];
    let presentation: Promise<void> | undefined;
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: sourceDelivery };
    const decision = {
      kind: "deliver" as const,
      payloads: [{ text: "done\nUsage: 1.3k total" } satisfies ReplyPayload],
    };
    admitTurn(turn, execution);
    state.account.mockImplementation(async () => {
      order.push("accounted");
      return { payloadArray: [{ text: "raw accounting reply" }] };
    });
    state.resolveDecision.mockImplementation(() => {
      order.push("decision");
      return decision;
    });
    state.deliver.mockImplementation(async () => {
      order.push("delivered");
      return { kind: "completed", payloads: decision.payloads };
    });
    state.completeLifecycle.mockImplementation(() => order.push("lifecycle-complete"));

    const run = createRunner({
      typing,
      typingMode: "instant",
      opts: {
        onQueuedFollowupSettled: () => {
          presentation = (async () => {
            order.push("presentation-settling");
            presentationStarted.resolve();
            await presentationGate.promise;
            order.push("presentation-settled");
          })();
          return presentation;
        },
      },
    })(turn.queued);

    const settledRun = Promise.allSettled([run]);
    try {
      await Promise.race([presentationStarted.promise, run]);
      expect(order).toContain("presentation-settling");
      expect(state.completeLifecycle).not.toHaveBeenCalled();
      expect(turn.operation.complete).not.toHaveBeenCalled();
      expect(endCorrelation).not.toHaveBeenCalled();
    } finally {
      presentationGate.resolve();
      await settledRun;
      await presentation;
    }
    await run;

    expect(endCorrelation).toHaveBeenCalledExactlyOnceWith(undefined);

    expect(order).toEqual([
      "progress-drained",
      "accounted",
      "decision",
      "delivered",
      "completion",
      "presentation-settling",
      "presentation-settled",
      "lifecycle-complete",
      "operation-complete",
    ]);
    expect(sourceDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payloads: decision.payloads }),
    );
  });

  it.each(["delivered", "filtered", "delivery-failed", "completion-failed"])(
    "closes queued continuation adoption after its delivery owner settles (%s)",
    async (outcome) => {
      let continuationOpen = true;
      let openAtCleanup: boolean | undefined;
      const adoptionResults: Array<boolean | undefined> = [];
      const adopt = vi.fn(() => continuationOpen);
      const statusPayload = setReplyPayloadMetadata(
        { text: "The worker is continuing." },
        {
          continuationStatus: true,
          progressContinuation: {
            adopt,
            close: () => {
              continuationOpen = false;
            },
          },
        },
      );
      const decision = { kind: "deliver", payloads: [statusPayload] };
      const draft = { push: () => undefined, retire: () => undefined };
      const failure = new Error("terminal delivery failed");
      const deliver = vi.fn(async (batch: QueuedFollowupReplyBatch) => {
        for (const payload of batch.payloads) {
          adoptionResults.push(
            getReplyPayloadMetadata(payload)?.progressContinuation?.adopt(draft),
          );
        }
        if (outcome === "completion-failed") {
          throw new Error("completion failed after adoption");
        }
      });
      turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
      state.resolveDecision.mockResolvedValue(decision);
      state.deliver.mockImplementation(async () => {
        if (outcome === "delivery-failed") {
          throw failure;
        }
        return {
          kind: "completed",
          payloads: outcome === "filtered" ? [] : decision.payloads,
        };
      });

      await createRunner({
        opts: {
          onQueuedFollowupSettled: async () => {
            openAtCleanup = continuationOpen;
          },
        },
      })(turn.queued);

      expect(adopt()).toBe(false);
      expect(openAtCleanup).toBe(true);
      expect(adoptionResults).toEqual(
        outcome === "delivered" || outcome === "completion-failed" ? [true] : [],
      );
      if (outcome === "delivery-failed") {
        expect(state.execute).toHaveBeenCalledOnce();
        expect(turn.operation.fail).toHaveBeenCalledWith("run_failed", failure);
        expect(deliver).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            completion: { kind: "failed", error: failure.message },
            payloads: [],
          }),
        );
      }
    },
  );

  it.each([true, false])(
    "settles source delivery correlations with visible=%s",
    async (visible) => {
      const onObservedReplyDelivery = vi.fn(async () => {});
      const endCorrelation = vi.fn();
      turn.queued.deliveryCorrelations = [{ begin: () => endCorrelation }];
      const execution = createSettledExecution();
      state.completedSourceDelivery = visible;
      admitTurn(turn, execution);

      await createRunner({
        typing,
        typingMode: "instant",
        opts: { onObservedReplyDelivery },
      })(turn.queued);

      expect(onObservedReplyDelivery).toHaveBeenCalledTimes(visible ? 1 : 0);
      expect(endCorrelation).toHaveBeenCalledExactlyOnceWith({
        visibleReplySent: visible,
        failed: false,
        completed: true,
      });
    },
  );
});
