import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChatSendLateFollowupDisposition } from "../../gateway/server-methods/chat-send-late-followup.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { ReplyPayload } from "../types.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  account: vi.fn(),
  admit: vi.fn(),
  completeLifecycle: vi.fn(),
  completedSourceDelivery: false,
  deliver: vi.fn(),
  execute: vi.fn(),
  resolveDecision: vi.fn(),
  clearRunContext: vi.fn(),
}));

vi.mock("../../infra/agent-run-registry.js", () => ({
  clearAgentRunContext: (...args: unknown[]) => state.clearRunContext(...args),
}));

vi.mock("../../agents/embedded-agent-runner/delivery-evidence.js", () => ({
  hasCompletedSourceReplyDeliveryEvidence: () => state.completedSourceDelivery,
}));

vi.mock("./agent-runner-result-accounting.js", () => ({
  accountFollowupTurn: (...args: unknown[]) => state.account(...args),
}));

vi.mock("./followup-turn-admission.js", () => ({
  admitFollowupTurn: (...args: unknown[]) => state.admit(...args),
  settleQueuedFollowupPresentation: async (defaults: {
    opts?: { onQueuedFollowupSettled?: () => Promise<void> | void };
  }) => {
    try {
      await defaults.opts?.onQueuedFollowupSettled?.();
    } catch {}
  },
}));

vi.mock("./followup-turn-execution.js", () => ({
  executeFollowupTurn: (...args: unknown[]) => state.execute(...args),
}));

vi.mock("./followup-delivery.js", () => ({
  deliverFollowupDecision: (...args: unknown[]) => state.deliver(...args),
  resolveFollowupDeliveryDecision: (...args: unknown[]) => state.resolveDecision(...args),
}));

vi.mock("./queue.js", () => ({
  completeFollowupRunLifecycle: (...args: unknown[]) => state.completeLifecycle(...args),
  FollowupRunDeferredError: class FollowupRunDeferredError extends Error {},
}));

vi.mock("../../runtime.js", () => ({ defaultRuntime: { error: vi.fn() } }));

const { createFollowupRunner } = await import("./followup-runner.js");
const { FollowupRunDeferredError } = await import("./queue.js");

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

function createTypingController() {
  return {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
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
        didLogHeartbeatStrip: false,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.completedSourceDelivery = false;
  state.resolveDecision.mockReturnValue({ kind: "suppress", reason: "silent" });
  state.deliver.mockResolvedValue({ kind: "completed", payloads: [] });
});

describe("createFollowupRunner", () => {
  it.each([true, false])(
    "publishes admission notices only for consumed execution (admission succeeds=%s)",
    async (succeeds) => {
      const turn = createTurn();
      const source = createChatSendLateFollowupDisposition({
        runId: "source-run",
        originatingChannel: "webchat",
        logGateway: { info: vi.fn() } as never,
        deliver: async () => ({ kind: "delivered" }),
      });
      source.recordQueued();
      turn.queued.originatingChannel = "webchat";
      turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: source.deliver };
      const failure = new Error("session generation changed after compaction");
      const notice = { text: "Context compacted", mediaUrl: "https://example.test/status.png" };
      const order: string[] = [];
      state.admit.mockImplementation(
        async (
          params: Parameters<typeof import("./followup-turn-admission.js").admitFollowupTurn>[0],
        ) => {
          await params.onCompactionNoticePayload?.(notice, turn);
          if (!succeeds) {
            throw failure;
          }
          return { kind: "admitted", turn };
        },
      );
      state.execute.mockImplementation(async () => {
        order.push("execution-settled");
        return createSettledExecution();
      });
      state.account.mockResolvedValue(undefined);
      state.deliver.mockImplementation(async () => {
        order.push("delivery");
        return { kind: "completed", payloads: [] };
      });
      const run = createFollowupRunner({
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
      });
      if (succeeds) {
        await run(turn.queued);
        expect(order).toEqual(["execution-settled", "delivery", "delivery"]);
        expect(state.deliver).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            kind: "block",
            decision: { kind: "deliver", payloads: [notice] },
            runId: turn.runId,
          }),
        );
      } else {
        await expect(run(turn.queued)).rejects.toBe(failure);
        expect(state.execute).not.toHaveBeenCalled();
        expect(state.deliver).not.toHaveBeenCalled();
        expect(state.completeLifecycle).not.toHaveBeenCalled();
      }
    },
  );

  it("delivers ordinary channel compaction-start while admission is still compacting", async () => {
    const turn = createTurn();
    turn.queued.originatingChannel = "discord";
    const order: string[] = [];
    state.admit.mockImplementation(
      async (
        params: Parameters<typeof import("./followup-turn-admission.js").admitFollowupTurn>[0],
      ) => {
        await params.onCompactionNoticePayload?.({ text: "Compacting context" }, turn);
        order.push("compaction-finished");
        return { kind: "admitted", turn };
      },
    );
    state.execute.mockImplementation(async () => {
      order.push("execution-settled");
      return createSettledExecution();
    });
    state.account.mockResolvedValue(undefined);
    state.deliver.mockImplementation(async (params: { kind?: string }) => {
      order.push(params.kind === "block" ? "notice-delivered" : "final-delivered");
      return { kind: "completed", payloads: [] };
    });
    await createFollowupRunner({
      typing: createTypingController(),
      typingMode: "never",
      defaultModel: "claude",
    })(turn.queued);
    expect(order).toEqual([
      "notice-delivered",
      "compaction-finished",
      "execution-settled",
      "final-delivered",
    ]);
  });

  it("closes the current run once after transferring source delivery to recovery", async () => {
    const turn = createTurn();
    const deliver = vi.fn(async () => {});
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockResolvedValue(createSettledExecution());
    state.account.mockResolvedValue(undefined);
    state.resolveDecision.mockReturnValue({
      kind: "retry-source-delivery",
      run: turn.queued,
      finalTextLength: 300,
      resolved: { provider: "anthropic", model: "claude" },
    });
    state.deliver.mockResolvedValue({ kind: "source-retry" });

    await createFollowupRunner({
      typing: createTypingController(),
      typingMode: "never",
      defaultModel: "claude",
    })(turn.queued);

    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: turn.runId,
        completion: { kind: "completed" },
        payloads: [],
      }),
    );
    expect(state.execute).toHaveBeenCalledOnce();
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
  });

  it.each(["silent", "send-policy", "room-event", "message-tool-only"] as const)(
    "settles the queued source when final delivery is suppressed by %s",
    async (reason) => {
      const turn = createTurn();
      const deliver = vi.fn(async () => {});
      turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
      const execution = createSettledExecution();
      state.admit.mockResolvedValue({ kind: "admitted", turn });
      state.execute.mockResolvedValue(execution);
      state.account.mockResolvedValue(undefined);
      state.resolveDecision.mockReturnValue({ kind: "suppress", reason });
      state.deliver.mockResolvedValue({ kind: "completed", payloads: [] });

      await createFollowupRunner({
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
      })(turn.queued);

      expect(deliver).toHaveBeenCalledExactlyOnceWith({
        kind: "queued-followup",
        runId: turn.runId,
        originatingChannel: undefined,
        payloads: [],
        completion: {
          kind: "completed",
          ...(reason === "silent" || reason === "message-tool-only"
            ? { allowCanvasOnly: true }
            : {}),
        },
      });
      expect(state.execute).toHaveBeenCalledOnce();
      expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    },
  );

  it.each(["timeout", "user", "restart", "superseded"] as const)(
    "preserves %s classification when the queue owns completion",
    async (reason) => {
      const turn = createTurn();
      const deliver = vi.fn(async () => {});
      turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
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
      state.admit.mockResolvedValue({ kind: "admitted", turn });
      state.execute.mockResolvedValue(execution);
      state.account.mockResolvedValue(undefined);
      state.deliver.mockResolvedValue({ kind: "completed", payloads: [] });

      await createFollowupRunner({
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
      })(turn.queued);

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
      expect(state.execute).toHaveBeenCalledOnce();
    },
  );

  it("retains its Gateway and drops caller authority through the delivery retry handoff", async () => {
    const turn = createTurn();
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
    state.account.mockResolvedValue(undefined);
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
    const run = createFollowupRunner({
      resolveGatewayContext,
      typing: createTypingController(),
      typingMode: "instant",
      defaultModel: "claude",
    });
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

  it("completes lifecycle and both typing signals for an already-aborted item", async () => {
    const typing = createTypingController();
    const controller = new AbortController();
    controller.abort();
    const queued = createQueuedRun({ abortSignal: controller.signal });

    await createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(queued);

    expect(state.admit).not.toHaveBeenCalled();
    expect(state.completeLifecycle).toHaveBeenCalledWith(queued);
    expect(typing.markRunComplete).toHaveBeenCalledOnce();
    expect(typing.markDispatchIdle).toHaveBeenCalledOnce();
  });

  it("turns active-lane deferral into a restorable queue error", async () => {
    const typing = createTypingController();
    const queued = createQueuedRun();
    state.admit.mockResolvedValue({ kind: "deferred", reason: "active-run" });

    await expect(
      createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(queued),
    ).rejects.toBeInstanceOf(FollowupRunDeferredError);

    expect(state.completeLifecycle).not.toHaveBeenCalled();
    expect(typing.markRunComplete).toHaveBeenCalledOnce();
    expect(typing.markDispatchIdle).toHaveBeenCalledOnce();
  });

  it("releases an operation acquired before asynchronous admission cancellation", async () => {
    const order: string[] = [];
    const typing = createTypingController();
    const turn = createTurn(order);
    state.admit.mockResolvedValue({
      kind: "skipped",
      reason: "aborted",
      operation: turn.operation,
    });

    await createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(
      turn.queued,
    );

    expect(order).toEqual(["operation-complete"]);
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
  });

  it("restores unexpected execution failures after releasing the admitted operation", async () => {
    const order: string[] = [];
    const typing = createTypingController();
    const turn = createTurn(order);
    const failure = new Error("candidate failed before settlement");
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockRejectedValue(failure);

    await expect(
      createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(turn.queued),
    ).rejects.toBe(failure);

    expect(state.completeLifecycle).not.toHaveBeenCalled();
    expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
    expect(order).toEqual(["operation-complete"]);
    expect(typing.markRunComplete).toHaveBeenCalledOnce();
    expect(typing.markDispatchIdle).toHaveBeenCalledOnce();
  });

  it("consumes a user abort before execution starts", async () => {
    const typing = createTypingController();
    const turn = createTurn([], { kind: "aborted", code: "aborted_by_user" });
    const deliver = vi.fn(async () => {});
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockRejectedValue(new Error("aborted before execution start"));

    await createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(
      turn.queued,
    );

    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
    expect(turn.operation.fail).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        completion: { kind: "aborted", stopReason: "aborted" },
        payloads: [],
      }),
    );
  });

  it("does not replay a returned execution when terminal delivery fails", async () => {
    const typing = createTypingController();
    const turn = createTurn();
    const execution = createRejectedExecution();
    const failure = new Error("terminal delivery failed");
    const deliver = vi.fn(async () => {});
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockResolvedValue(execution);
    state.account.mockResolvedValue(undefined);
    state.resolveDecision.mockReturnValue({
      kind: "deliver",
      payloads: [{ text: "terminal failure", isError: true }],
    });
    state.deliver.mockRejectedValue(failure);

    await createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(
      turn.queued,
    );

    expect(state.execute).toHaveBeenCalledOnce();
    expect(state.account).toHaveBeenCalledOnce();
    expect(state.deliver).toHaveBeenCalledOnce();
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
    expect(turn.operation.fail).toHaveBeenCalledWith("run_failed", failure);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        completion: { kind: "failed", error: failure.message },
        payloads: [],
      }),
    );
  });

  it("holds the reply operation through progress drain, accounting, and delivery", async () => {
    const order: string[] = [];
    const typing = createTypingController();
    const turn = createTurn(order);
    const execution = createRejectedExecution(order);
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockResolvedValue(execution);
    state.account.mockImplementation(async () => {
      order.push("accounted");
      return undefined;
    });
    state.resolveDecision.mockImplementation(() => {
      order.push("decision");
      return { kind: "deliver", payloads: [{ text: "done" } satisfies ReplyPayload] };
    });
    state.deliver.mockImplementation(async () => {
      order.push("delivered");
      return { kind: "completed", payloads: [] };
    });
    state.completeLifecycle.mockImplementation(() => order.push("lifecycle-complete"));

    await createFollowupRunner({
      typing,
      typingMode: "instant",
      defaultModel: "claude",
      opts: {
        onQueuedFollowupSettled: () => {
          order.push("presentation-settled");
        },
      },
    })(turn.queued);

    expect(order).toEqual([
      "progress-drained",
      "accounted",
      "decision",
      "delivered",
      "presentation-settled",
      "lifecycle-complete",
      "operation-complete",
    ]);
    expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
  });

  it.each([true, false])(
    "projects queued commentary with the refreshed durable owner when enabled is %s",
    async (commentaryPayloadsEnabled) => {
      const typing = createTypingController();
      const turn = createTurn();
      const execution = Object.assign(createRejectedExecution(), {
        commentaryPayloadsEnabled,
      });
      state.admit.mockResolvedValue({ kind: "admitted", turn });
      state.execute.mockResolvedValue(execution);
      state.account.mockResolvedValue(undefined);
      state.deliver.mockResolvedValue({ kind: "completed", payloads: [] });

      await createFollowupRunner({
        typing,
        typingMode: "instant",
        defaultModel: "claude",
        opts: { commentaryPayloadsEnabled: !commentaryPayloadsEnabled },
      })(turn.queued);

      expect(state.resolveDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          opts: expect.objectContaining({ commentaryPayloadsEnabled }),
        }),
      );
    },
  );

  it("does not replay a settled turn when progress presentation fails", async () => {
    const typing = createTypingController();
    const turn = createTurn();
    const execution = createSettledExecution();
    const deliver = vi.fn(async () => {});
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
    execution.progress.drain = vi.fn(async () => {
      throw new Error("presentation failed");
    });
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockResolvedValue(execution);
    state.account.mockResolvedValue(undefined);
    state.resolveDecision.mockReturnValue({ kind: "suppress", reason: "silent" });
    state.deliver.mockResolvedValue({ kind: "completed", payloads: [] });

    await createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(
      turn.queued,
    );

    expect(state.execute).toHaveBeenCalledOnce();
    expect(state.account).toHaveBeenCalledOnce();
    expect(state.deliver).toHaveBeenCalledOnce();
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    expect(turn.operation.fail).toHaveBeenCalledWith("run_failed", expect.any(Error));
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        completion: { kind: "failed", error: "presentation failed" },
      }),
    );
  });

  it("reports a completed message-tool source delivery before final projection", async () => {
    const typing = createTypingController();
    const onObservedReplyDelivery = vi.fn(async () => {});
    const turn = createTurn();
    const execution = createSettledExecution();
    state.completedSourceDelivery = true;
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockResolvedValue(execution);
    state.account.mockResolvedValue({});
    state.deliver.mockResolvedValue({ kind: "completed", payloads: [] });

    await createFollowupRunner({
      typing,
      typingMode: "instant",
      defaultModel: "claude",
      opts: { onObservedReplyDelivery },
    })(turn.queued);

    expect(onObservedReplyDelivery).toHaveBeenCalledOnce();
  });
});
