import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressCard } from "../../../packages/gateway-protocol/src/index.js";
import {
  createSettledExecution,
  createTurn,
} from "../../auto-reply/reply/followup-delivery.test-helpers.js";
import { createFollowupRunner } from "../../auto-reply/reply/followup-runner.js";
import type { FollowupExecutionResult } from "../../auto-reply/reply/followup-turn-execution.js";
import { scheduleFollowupDrain } from "../../auto-reply/reply/queue/drain.js";
import { enqueueFollowupRun, reserveSteerCandidate } from "../../auto-reply/reply/queue/enqueue.js";
import { admitFollowupRunLifecycle } from "../../auto-reply/reply/queue/lifecycle.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { FollowupRun, QueueSettings } from "../../auto-reply/reply/queue/types.js";
import type { AdmittedFollowupTurn } from "../../auto-reply/reply/reply-agent-turn-preparation.js";
import { createMockTypingController } from "../../auto-reply/reply/test-helpers.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  bindSessionControllerSource,
  claimSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import {
  requestRpcSourceCancellation,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import type { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import { createChatSendTurnAdoptionLifecycle } from "./chat-send-turn-adoption.js";
import { requestProgressCardRefresh } from "./progress-card-refresh.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  send: vi.fn<typeof handleTrustedInternalChatSend>(),
  admit:
    vi.fn<
      typeof import("../../auto-reply/reply/reply-agent-turn-preparation.js").prepareReplyAgentTurn
    >(),
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
vi.mock("../../auto-reply/reply/reply-agent-turn-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../auto-reply/reply/reply-agent-turn-preparation.js")
  >()),
  prepareReplyAgentTurn: mocks.admit,
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

function fixture(options: { parkSteer?: boolean; onQueuedFollowupSettled?: () => void } = {}) {
  const sessionKey = `agent:work:queued-refresh-` + randomUUID();
  queueKeys.add(sessionKey);
  const scope = {
    storeScope: "/synthetic/progress-refresh/" + randomUUID(),
    sessionKey,
    sessionId: "session",
    agentId: "work",
  };
  const { storeScope, ...identity } = scope;
  const target = { sessionKey, agentId: identity.agentId };
  const card: ProgressCard = { sessionKey, revision: 7, updatedAt: 1, markdown: "Previous status" };
  const context = {
    chatRunState: createChatRunState(),
    dedupe: new Map(),
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
  const sources: Array<{
    runId: string;
    queued: FollowupRun;
    controller: AbortController;
    sourceRef: RpcSourceRef;
    release: ReturnType<typeof vi.fn>;
    parked?: ReturnType<typeof reserveSteerCandidate>;
  }> = [];
  const runFollowup = createFollowupRunner({
    opts: { onQueuedFollowupSettled: options.onQueuedFollowupSettled },
    defaultModel: "test",
    typingMode: "never",
    typing: createMockTypingController(),
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
    const registration = registerChatAbortController({
      runId,
      ...identity,
      timeoutMs: 1_000,
      controlUiVisible: false,
      projectSessionActive: false,
      target: captureSessionTarget({
        storeScope,
        ...target,
        incarnation: identity.sessionId,
      }),
    });
    const sourceRef = expectDefined(registration.entry, "refresh source");
    const controller = registration.controller;
    const release = vi.fn();

    const adoption = createChatSendTurnAdoptionLifecycle({
      accountId: undefined,
      sourceRef,
      context,
      runId,
      controller,
      ...target,
      originatingChannel: "webchat",
      session: {
        ...target,
        backingSessionId: "session",
        cfg: {},
        clientRunId: runId,
        sessionLoadOptions: { agentId: "work" },
      },
      hasCronCreatorAuthority: false,
      suppressReplies: true,
      releaseSourceWorkAdmission: release,
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
        ...identity,
        agentDir: "/unused-agent",
        sessionFile: "/unused-session.jsonl",
        workspaceDir: "/unused-workspace",
        config: { session: { store: storeScope } },
        provider: "test",
        model: "test",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
        inputProvenance: { kind: "internal_system", sourceTool: "progress_card_refresh" },
      },
    };
    bindSessionControllerSource(sourceRef.input, queued);
    const parked = options.parkSteer
      ? reserveSteerCandidate(sessionKey, queued, queueSettings, runFollowup)
      : undefined;
    if (options.parkSteer) {
      expect(parked).toBeDefined();
    } else {
      expect(enqueueFollowupRun(sessionKey, queued, queueSettings, "none", undefined, false)).toBe(
        true,
      );
    }
    registration.cleanup();
    sources.push({ runId, queued, controller, sourceRef, parked, release });
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:` + runId,
      entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok" } },
    });
    request.respond(true, { runId, status: "started" });
  });
  const refresh = async (key = "click-1") => {
    invocation.respond.mockClear();
    await requestProgressCardRefresh(invocation, target, card, key, async () => card);
    return invocation.respond;
  };
  const start = async () => {
    expectAccepted(await refresh());
    return expectDefined(sources[0], "queued refresh");
  };
  return { context, card, sources, sessionKey, scope, refresh, start, runFollowup };
}

async function expectReleased(source: Awaited<ReturnType<ReturnType<typeof fixture>["start"]>>) {
  await source.sourceRef.input.settlement.promise;
  expect(rpcSourceTesting.has(source.runId)).toBe(false);
  expect(source.release).toHaveBeenCalledOnce();
}

function holdQueuedExecution(f: ReturnType<typeof fixture>) {
  const entered = createDeferredCore<AdmittedFollowupTurn>();
  const releaseExecution = createDeferredCore();
  const runnerDone = createDeferredCore();
  mocks.admit.mockImplementation(async ({ queued }) => {
    const mailboxClaim = await claimSessionControllerInput(queued);
    await admitFollowupRunLifecycle(queued);
    const operation = createReplyOperation({
      sessionKey: f.sessionKey,
      sessionId: "session",
      mailboxClaim,
      target: mailboxClaim.mailbox.owner.target,
      resetTriggered: false,
    });
    return {
      kind: "admitted",
      configured: undefined,
      turn: createTurn({
        runId: randomUUID(),
        queued,
        operation,
        session: { kind: "detached", current: () => undefined, publish: () => {} },
      }),
    };
  });
  mocks.execute.mockImplementation(async ({ turn }) => {
    turn.operation.setPhase("running");
    markReplyOperationExecutionStarted(turn.operation);
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
    turn.operation.freezeAbort();
    const execution = createSettledExecution();
    execution.runId = turn.runId;
    execution.outcome.resolved = { provider: "test", model: "test" };
    execution.outcome.result.meta = { durationMs: 0 };
    return {
      commentaryPayloadsEnabled: false,
      execution,
      runStartedAt: Date.now(),
      sessionCtx: {},
      pendingToolTasks: new Set(),
      progress: { drain: async () => {} },
    } satisfies FollowupExecutionResult;
  });
  const runner = async (run: FollowupRun) => {
    const completion = f.runFollowup(run);
    runnerDone.resolve(completion);
    await completion;
  };
  scheduleFollowupDrain(f.sessionKey, runner);
  const finish = async () => {
    releaseExecution.resolve();
    await runnerDone.promise;
  };
  cleanups.push(finish);
  return { entered: entered.promise, finish };
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
  it("reconciles queued completion before a new intent despite late cancellation", async () => {
    const onQueuedFollowupSettled = vi.fn(() => requestRpcSourceCancellation(source.sourceRef));
    const f = fixture({ onQueuedFollowupSettled });
    const originalCard = structuredClone(f.card);
    const source = await f.start();
    const execution = holdQueuedExecution(f);
    const turn = await execution.entered;
    expect(turn.runId).not.toBe(source.runId);
    expect(turn.queued.controllerInput).toBe(source.sourceRef.input);
    expect(rpcSourceTesting.get(source.runId)).toBe(source.sourceRef);
    expectAccepted(await f.refresh());
    expect(f.sources).toHaveLength(1);
    expect(source.release).not.toHaveBeenCalled();

    await execution.finish();
    await expectReleased(source);
    expect(onQueuedFollowupSettled).toHaveBeenCalledOnce();
    expect(onQueuedFollowupSettled).toHaveReturnedWith(false);
    expectTerminal(await f.refresh());
    expect(f.context.dedupe.get(`chat:` + source.runId)?.payload).toMatchObject({
      status: "completed",
    });
    expect(f.card).toEqual(originalCard);
    expect(f.context.broadcast).not.toHaveBeenCalled();
    expectAccepted(await f.refresh("click-2"));
    expect(f.sources).toHaveLength(2);
    expect(f.sources[1]?.runId).not.toBe(source.runId);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("does not turn consumed steering custody into terminal completion", async () => {
    const f = fixture({ parkSteer: true });
    const source = await f.start();
    expect(await source.parked?.admit()).toBe("steer");
    await admitFollowupRunLifecycle(source.queued);
    source.parked?.consume("consumed");
    await expectReleased(source);
    expectAccepted(await f.refresh());
    expect(f.context.dedupe.get(`chat:` + source.runId)?.payload).toMatchObject({ status: "ok" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("settles an abandoned pending refresh through actual queue overflow", async () => {
    const f = fixture();
    const source = await f.start();
    const replacement: FollowupRun = {
      ...source.queued,
      controllerInput: undefined,
      controllerClaim: undefined,
      abortSignal: undefined,
      turnAdoptionLifecycle: undefined,
      queuedFollowupReplyDisposition: undefined,
    };
    const replacementSource = createRpcSourceForTest({}, f.scope);
    bindSessionControllerSource(replacementSource.input, replacement);
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
    await expectReleased(source);
    expectTerminal(await f.refresh());
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(["source", "signal"])(
    "retires a cancelled queued refresh before %s abort removes its owner",
    async (mode) => {
      const f = fixture();
      const source = await f.start();
      if (mode === "signal") {
        source.controller.abort();
      } else {
        expect(requestRpcSourceCancellation(source.sourceRef)).toBe(true);
      }
      await expectReleased(source);
      expectTerminal(await f.refresh());
      expect(f.context.dedupe.get(`chat:${source.runId}`)?.payload).toMatchObject({
        status: "timeout",
        summary: "aborted",
      });
      expectAccepted(await f.refresh("after-abort"));
      expect(f.sources).toHaveLength(2);
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );

  it("does not let a revoked queued controller overwrite its successor receipt", async () => {
    const f = fixture();
    const source = await f.start();
    const execution = holdQueuedExecution(f);
    await execution.entered;
    source.controller.abort();
    const successor = createRpcSourceForTest(
      {},
      {
        ...f.scope,
        runId: source.runId,
        phase: "waiting",
        sessionId: "successor-session",
      },
    );
    // The old producer retains custody; replacing correlation cannot transfer it.
    rpcSourceTesting.set(source.runId, successor);
    const successorReceipt = {
      ts: Date.now(),
      ok: true,
      payload: { runId: source.runId, status: "started" },
    };
    f.context.dedupe.set(`chat:` + source.runId, successorReceipt);
    await execution.finish();
    await source.sourceRef.input.settlement.promise;
    expect(rpcSourceTesting.get(source.runId)).toBe(successor);
    expect(f.context.dedupe.get(`chat:` + source.runId)).toBe(successorReceipt);
    expect(source.release).toHaveBeenCalledOnce();
    expectAccepted(await f.refresh());
    requestRpcSourceCancellation(successor);
  });
});
