import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressCard } from "../../../packages/gateway-protocol/src/index.js";
import { createFollowupRunner } from "../../auto-reply/reply/followup-runner.js";
import type {
  AdmittedFollowupTurn,
  FollowupRunnerParams,
} from "../../auto-reply/reply/followup-turn-admission.js";
import type { FollowupExecutionResult } from "../../auto-reply/reply/followup-turn-execution.js";
import { scheduleFollowupDrain } from "../../auto-reply/reply/queue/drain.js";
import { enqueueFollowupRun, parkSteerCandidate } from "../../auto-reply/reply/queue/enqueue.js";
import { admitFollowupRunLifecycle } from "../../auto-reply/reply/queue/lifecycle.js";
import {
  clearFollowupQueue,
  getExistingFollowupQueue,
} from "../../auto-reply/reply/queue/state.js";
import type { FollowupRun, QueueSettings } from "../../auto-reply/reply/queue/types.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import {
  abortQueuedChatTurnById,
  abortQueuedChatTurns,
  registerQueuedChatTurn,
} from "../chat-queued-turns.js";
import type { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import { createChatSendTurnAdoptionLifecycle } from "./chat-send-turn-adoption.js";
import { requestProgressCardRefresh } from "./progress-card-refresh.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  send: vi.fn<typeof handleTrustedInternalChatSend>(),
  admit:
    vi.fn<typeof import("../../auto-reply/reply/followup-turn-admission.js").admitFollowupTurn>(),
  execute:
    vi.fn<typeof import("../../auto-reply/reply/followup-turn-execution.js").executeFollowupTurn>(),
}));

vi.mock("./chat-send-handler.js", () => ({ handleTrustedInternalChatSend: mocks.send }));
// Hidden refreshes must never load or invoke visible reply/transcript delivery.
vi.mock("./chat-send-source-finalization.js", () => ({
  createChatSendLateReplyFinalizer: () => {
    throw new Error("hidden refresh attempted visible reply delivery");
  },
}));
// Keep enqueue, drain, adoption, completion, and the followup runner real. Only
// replace session/provider admission and the execution/accounting/delivery edges.
vi.mock("../../auto-reply/reply/followup-turn-admission.js", () => ({
  admitFollowupTurn: mocks.admit,
  settleQueuedFollowupPresentation: async (defaults: FollowupRunnerParams) => {
    await defaults.opts?.onQueuedFollowupSettled?.();
  },
}));
vi.mock("../../auto-reply/reply/followup-turn-execution.js", () => ({
  executeFollowupTurn: mocks.execute,
}));
vi.mock("../../auto-reply/reply/agent-runner-result-accounting.js", () => ({
  accountFollowupTurn: async () => undefined,
}));
vi.mock("../../auto-reply/reply/followup-delivery.js", () => ({
  resolveFollowupDeliveryDecision: async () => ({ kind: "suppress", reason: "silent" }),
  deliverFollowupDecision: async () => ({ kind: "completed", payloads: [] }),
}));

const queueSettings: QueueSettings = {
  mode: "followup",
  debounceMs: 0,
  cap: 10,
  dropPolicy: "old",
};
const queueKeys = new Set<string>();
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  for (const key of queueKeys) {
    clearFollowupQueue(key);
  }
  queueKeys.clear();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});

function settledExecution(runId: string): FollowupExecutionResult {
  return {
    commentaryPayloadsEnabled: false,
    execution: {
      runId,
      outcome: {
        kind: "settled",
        status: "ok",
        result: { payloads: [], meta: { durationMs: 0 } },
        resolved: { provider: "test", model: "test" },
        fallback: { exhausted: false, attempts: [] },
        autoCompactionCount: 0,
        didLogHeartbeatStrip: false,
      },
    },
    runStartedAt: Date.now(),
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: { drain: async () => {} },
  };
}

function fixture(options: { parkSteer?: boolean } = {}) {
  const sessionKey = `agent:work:queued-refresh-` + randomUUID();
  queueKeys.add(sessionKey);
  const card: ProgressCard = { sessionKey, revision: 7, updatedAt: 1, markdown: "Previous status" };
  const context = {
    dedupe: new Map(),
    chatQueuedTurns: new Map(),
    broadcast: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as GatewayRequestContext;
  const invocation = {
    req: { type: "req", id: "refresh", method: "progressCard.refresh" },
    params: {},
    context,
    respond: vi.fn<RespondFn>(),
    client: null,
    isWebchatConnect: () => true,
  } satisfies GatewayRequestHandlerOptions;
  const releases = new Map<string, ReturnType<typeof vi.fn>>();
  const sources = new Map<
    string,
    {
      queued: FollowupRun;
      adoption: ReturnType<typeof createChatSendTurnAdoptionLifecycle>;
      controller: AbortController;
      parked?: ReturnType<typeof parkSteerCandidate>;
    }
  >();
  const runFollowup = createFollowupRunner({
    defaultModel: "test",
    typingMode: "never",
    typing: {
      onReplyStart: async () => {},
      startTypingLoop: async () => {},
      startTypingOnText: async () => {},
      refreshTypingTtl: () => {},
      isActive: () => false,
      markRunComplete: () => {},
      markDispatchIdle: () => {},
      cleanup: () => {},
    },
  });
  // This bounded admission adapter replays the real Gateway dedupe map. It does
  // not implement queued completion: only the real runner/lifecycle may do that.
  mocks.send.mockImplementation(async (request) => {
    const runId = request.params.idempotencyKey;
    if (typeof runId !== "string") {
      throw new Error("missing refresh idempotency key");
    }
    const cached = context.dedupe.get(`chat:` + runId);
    if (cached) {
      request.respond(cached.ok, cached.payload, cached.error);
      return;
    }
    const controller = new AbortController();
    const release = vi.fn();
    releases.set(runId, release);
    const adoption = createChatSendTurnAdoptionLifecycle({
      accountId: undefined,
      chatQueuedTurns: context.chatQueuedTurns,
      context,
      runId,
      controller,
      sessionBinding: {
        sessionId: "session",
        sessionKey,
        agentId: "work",
        lifecycleGeneration: "test-generation",
      },
      sessionKey,
      agentId: "work",
      originatingChannel: "webchat",
      session: {
        agentId: "work",
        backingSessionId: "session",
        cfg: {},
        clientRunId: runId,
        sessionKey,
        sessionLoadOptions: { agentId: "work" },
      },
      hasCronCreatorAuthority: false,
      suppressReplies: true,
      retainWorkAdmission: () => release,
    });
    const queued: FollowupRun = {
      prompt: String(request.params.message),
      enqueuedAt: Date.now(),
      abortSignal: controller.signal,
      turnAdoptionLifecycle: adoption.lifecycle,
      queuedFollowupReplyDisposition: {
        kind: "deliver",
        deliver: adoption.onQueuedFollowupReplyBatch,
      },
      originatingChannel: "webchat",
      run: {
        agentId: "work",
        agentDir: "/unused-agent",
        sessionId: "session",
        sessionKey,
        sessionFile: "/unused-session.jsonl",
        workspaceDir: "/unused-workspace",
        config: {},
        provider: "test",
        model: "test",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
        inputProvenance: { kind: "internal_system", sourceTool: "progress_card_refresh" },
      },
    };
    const parked = options.parkSteer
      ? parkSteerCandidate(sessionKey, queued, queueSettings, runFollowup)
      : undefined;
    if (options.parkSteer) {
      expect(parked).toBeDefined();
    } else {
      expect(enqueueFollowupRun(sessionKey, queued, queueSettings, "none", undefined, false)).toBe(
        true,
      );
    }
    sources.set(runId, { queued, adoption, controller, parked });
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:` + runId,
      entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok" } },
    });
    request.respond(true, { runId, status: "started" });
  });
  const refresh = async (key = "click-1") => {
    invocation.respond.mockClear();
    await requestProgressCardRefresh(
      invocation,
      { sessionKey, agentId: "work" },
      card,
      key,
      async () => card,
    );
    return invocation.respond;
  };
  const first = () => {
    const item = sources.entries().next().value;
    if (!item) {
      throw new Error("refresh was not queued");
    }
    return { runId: item[0], ...item[1] };
  };
  return { context, card, sources, sessionKey, releases, refresh, first, runFollowup };
}

function holdQueuedExecution(f: ReturnType<typeof fixture>) {
  const entered = createDeferredCore<AdmittedFollowupTurn>();
  const releaseExecution = createDeferredCore();
  const runnerDone = createDeferredCore();
  mocks.admit.mockImplementation(async ({ queued }) => {
    await admitFollowupRunLifecycle(queued);
    return {
      kind: "admitted",
      turn: {
        runId: randomUUID(),
        queued,
        operation: createReplyOperation({
          sessionKey: f.sessionKey,
          sessionId: "session",
          resetTriggered: false,
        }),
        config: {},
        session: { kind: "detached", current: () => undefined, publish: () => {}, adopt: () => {} },
        sendPolicy: "allow",
        preflightCompactionApplied: false,
      },
    };
  });
  mocks.execute.mockImplementation(async ({ turn }) => {
    const source = turn.queued.queuedFollowupReplyDisposition;
    if (source?.kind !== "deliver") {
      throw new Error("queued refresh lost its delivery owner");
    }
    await source.deliver({
      kind: "queued-followup",
      runId: turn.runId,
      originatingChannel: "webchat",
      payloads: [{ text: "Still checking" }],
      completion: { kind: "progress" },
    });
    entered.resolve(turn);
    await releaseExecution.promise;
    return settledExecution(turn.runId);
  });
  const runner = async (run: FollowupRun) => {
    try {
      await f.runFollowup(run);
      runnerDone.resolve();
    } catch (error) {
      runnerDone.reject(error);
      throw error;
    }
  };
  scheduleFollowupDrain(f.sessionKey, runner);
  cleanups.push(async () => {
    releaseExecution.resolve();
    await runnerDone.promise;
  });
  return {
    entered: entered.promise,
    finish: async () => {
      releaseExecution.resolve();
      await runnerDone.promise;
    },
  };
}

function expectAccepted(respond: ReturnType<typeof vi.fn<RespondFn>>) {
  expect(respond).toHaveBeenLastCalledWith(
    true,
    expect.objectContaining({ status: "accepted", revision: 7 }),
    undefined,
    undefined,
  );
}

function expectTerminal(respond: ReturnType<typeof vi.fn<RespondFn>>) {
  expect(respond).toHaveBeenLastCalledWith(
    false,
    undefined,
    expect.objectContaining({ details: { code: "PROGRESS_CARD_REFRESH_TERMINAL" } }),
    undefined,
  );
}

describe("queued progress refresh settlement", () => {
  it("keeps progress pending, then reconciles the separate followup run before retrying a new intent", async () => {
    const f = fixture();
    expectAccepted(await f.refresh());
    const source = f.first();
    const execution = holdQueuedExecution(f);
    const turn = await execution.entered;
    expect(turn.runId).not.toBe(source.runId);
    expect(getExistingFollowupQueue(f.sessionKey)?.inFlight.has(source.queued)).toBe(true);
    expectAccepted(await f.refresh());
    expect(f.sources.size).toBe(1);
    expect(f.releases.get(source.runId)).not.toHaveBeenCalled();

    await execution.finish();
    expect(f.context.chatQueuedTurns.has(source.runId)).toBe(false);
    expect(f.releases.get(source.runId)).toHaveBeenCalledOnce();
    expectTerminal(await f.refresh());
    expect(f.context.dedupe.get(`chat:` + source.runId)?.payload).toMatchObject({
      status: "completed",
    });
    expect(f.card).toEqual({
      sessionKey: f.sessionKey,
      revision: 7,
      updatedAt: 1,
      markdown: "Previous status",
    });
    expect(f.context.broadcast).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledOnce();

    expectAccepted(await f.refresh("click-2"));
    expect(f.sources.size).toBe(2);
    expect([...f.sources.keys()][1]).not.toBe(source.runId);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("does not turn consumed steering custody into terminal completion", async () => {
    const f = fixture({ parkSteer: true });
    expectAccepted(await f.refresh());
    const source = f.first();
    expect(await source.parked?.admit()).toBe("steer");
    await admitFollowupRunLifecycle(source.queued);
    source.parked?.consume("consumed");
    expect(f.context.chatQueuedTurns.has(source.runId)).toBe(false);
    expect(f.releases.get(source.runId)).toHaveBeenCalledOnce();
    expectAccepted(await f.refresh());
    expect(f.context.dedupe.get(`chat:` + source.runId)?.payload).toMatchObject({ status: "ok" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("settles an abandoned pending refresh through actual queue overflow", async () => {
    const f = fixture();
    expectAccepted(await f.refresh());
    const source = f.first();
    const replacement: FollowupRun = {
      ...source.queued,
      turnAdoptionLifecycle: undefined,
      queuedFollowupReplyDisposition: undefined,
    };
    expect(
      enqueueFollowupRun(
        f.sessionKey,
        replacement,
        { ...queueSettings, cap: 1 },
        "none",
        undefined,
        false,
      ),
    ).toBe(true);
    expect(f.context.chatQueuedTurns.has(source.runId)).toBe(false);
    expect(f.releases.get(source.runId)).toHaveBeenCalledOnce();
    expectTerminal(await f.refresh());
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(["single", "bulk", "signal"])(
    "retires a cancelled queued refresh before %s abort removes its owner",
    async (mode) => {
      const f = fixture();
      expectAccepted(await f.refresh());
      const source = f.first();
      if (mode === "single") {
        expect(
          abortQueuedChatTurnById(f.context.chatQueuedTurns, {
            runId: source.runId,
            sessionKey: f.sessionKey,
            stopReason: "rpc",
          }).aborted,
        ).toBe(true);
      } else if (mode === "bulk") {
        const entry = f.context.chatQueuedTurns.get(source.runId);
        if (!entry) {
          throw new Error("Missing queued refresh owner");
        }
        expect(
          abortQueuedChatTurns(f.context.chatQueuedTurns, [{ runId: source.runId, entry }], "rpc"),
        ).toEqual([source.runId]);
      } else {
        source.controller.abort();
      }
      expect(f.context.chatQueuedTurns.has(source.runId)).toBe(false);
      expectTerminal(await f.refresh());
      expect(f.context.dedupe.get(`chat:${source.runId}`)?.payload).toMatchObject({
        status: "timeout",
        summary: "aborted",
      });
      expectAccepted(await f.refresh("after-abort"));
      expect(f.sources.size).toBe(2);
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );

  it("does not let a revoked queued controller overwrite its successor receipt", async () => {
    const f = fixture();
    await f.refresh();
    const source = f.first();
    const execution = holdQueuedExecution(f);
    await execution.entered;
    source.controller.abort();
    const successor = new AbortController();
    expect(
      registerQueuedChatTurn({
        chatQueuedTurns: f.context.chatQueuedTurns,
        runId: source.runId,
        controller: successor,
        sessionId: "successor-session",
        sessionKey: f.sessionKey,
        agentId: "work",
      }),
    ).toBe(true);
    const successorReceipt = {
      ts: Date.now(),
      ok: true,
      payload: { runId: source.runId, status: "started" },
    };
    f.context.dedupe.set(`chat:` + source.runId, successorReceipt);
    await execution.finish();
    expect(f.context.chatQueuedTurns.get(source.runId)?.controller).toBe(successor);
    expect(f.context.dedupe.get(`chat:` + source.runId)).toBe(successorReceipt);
    expect(f.releases.get(source.runId)).toHaveBeenCalledOnce();
    expectAccepted(await f.refresh());
    successor.abort();
  });
});
