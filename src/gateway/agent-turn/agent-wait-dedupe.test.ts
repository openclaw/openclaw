import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun, reserveSteerCandidate } from "../../auto-reply/reply/queue/enqueue.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionControllerSourceInjection,
  bindSessionControllerSource,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import {
  registerRpcSource,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureUserProfilesSchema } from "../../state/user-profiles-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { agentHandlers } from "../server-methods/agent.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import type { DedupeEntry } from "../server-shared.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { replayAgentTurnIfCached } from "./agent-dedupe.js";
import * as agentJobs from "./agent-job.js";
import { setGatewayDedupeEntry, waitForAgentJob } from "./agent-job.js";
import { createAgentTurnService } from "./agent-turn-service.js";
import { prepareAgentWaitForTurn } from "./agent-wait.js";
import { createTestRpcSource, testRpcSourceController } from "./rpc-source.test-support.js";

type WaitArgs = Parameters<NonNullable<(typeof agentHandlers)["agent.wait"]>>[0];
function invokeWait(
  context: WaitArgs["context"],
  runId: string,
  timeoutMs: number,
  client: WaitArgs["client"] = null,
  isWebchat = false,
  respond = vi.fn(),
) {
  const handler = expectDefined(agentHandlers["agent.wait"], "registered wait handler");
  return {
    respond,
    promise: handler({
      req: { type: "req", id: runId, method: "agent.wait" },
      params: { runId, timeoutMs },
      respond,
      context,
      client,
      isWebchatConnect: () => isWebchat,
    }),
  };
}

async function expectReply(waiter: ReturnType<typeof invokeWait>, payload: unknown) {
  await waiter.promise;
  expect(waiter.respond).toHaveBeenCalledWith(true, payload);
}

const pendingResult = (runId: string) => ({
  runId,
  status: "pending",
  timeoutPhase: "queue",
  providerStarted: false,
});
const hardTimeout = { status: "timeout", endedAt: 200, timeoutPhase: "provider" };
const userCancellation = { status: "error", endedAt: 150, stopReason: "rpc" };

function lifecycle(runId: string, data: Record<string, unknown>) {
  emitAgentEvent({ runId, stream: "lifecycle", data });
}

type DedupeWrite = Parameters<typeof setGatewayDedupeEntry>[0];
function writeObservation(
  dedupe: DedupeWrite["dedupe"],
  runId: string,
  payload: Record<string, unknown>,
  {
    source = "agent",
    ts = Date.now(),
    ok = true,
    requestIdentity,
    ...options
  }: {
    source?: "agent" | "chat";
    ts?: number;
    ok?: boolean;
    requestIdentity?: string;
  } & Pick<DedupeWrite, "session" | "startNewAttempt"> = {},
) {
  setGatewayDedupeEntry({
    dedupe,
    key: `${source}:${runId}`,
    entry: {
      ts,
      ok,
      payload: { runId, ...payload },
      ...(requestIdentity ? { requestIdentity } : {}),
    },
    ...options,
  });
}

function waitThroughGateway(
  params: { runId: string; timeoutMs: number },
  activeKind?: "agent" | "chat",
) {
  const respond = vi.fn();
  const handler = expectDefined(
    agentHandlers["agent.wait"],
    'agentHandlers["agent.wait"] test invariant',
  );
  const source = activeKind
    ? createTestRpcSource(
        {
          kind: activeKind === "agent" ? "agent" : "chat-send",
          sessionKey: "agent:main:wait",
          sessionId: "wait-session",
        },
        params.runId,
      )
    : undefined;
  const claim = source ? claimSessionControllerTask(source.input, () => {}) : undefined;
  rpcSourceTesting.reset(source ? [[params.runId, source]] : []);
  const promise = (async () => {
    try {
      return await handler({
        params,
        respond,
        context: { dedupe: new Map() },
      } as unknown as Parameters<typeof handler>[0]);
    } finally {
      if (claim !== undefined) {
        releaseSessionControllerClaim(await claim);
      }
    }
  })();
  return { promise, respond };
}

function completeRun(
  dedupe: Map<string, DedupeEntry>,
  runId: string,
  source: "agent" | "chat" = "agent",
): void {
  writeObservation(dedupe, runId, { status: "ok", startedAt: 100, endedAt: 200 }, { source });
}

let runSequence = 0;
function runFixture(dedupe = new Map<string, DedupeEntry>()) {
  const runId = `dedupe-${++runSequence}`;
  return {
    runId,
    dedupe,
    write: (payload: Record<string, unknown>, options?: Parameters<typeof writeObservation>[3]) =>
      writeObservation(dedupe, runId, payload, options),
    wait: (timeoutMs = 0, source?: "agent" | "chat") =>
      waitThroughGateway({ runId, timeoutMs }, source),
    complete: (source?: "agent" | "chat") => completeRun(dedupe, runId, source),
    job: () => waitForAgentJob({ runId, timeoutMs: 0 }),
  };
}

async function ownedWaitSession(sessionKey: string, sessionId: string, ownerId: string) {
  const cfg = rolePolicyConfig();
  setRuntimeConfigSnapshot(cfg);
  ensureUserProfilesSchema({});
  const catalog = await prepareUserProfileCatalog();
  try {
    const owner = roleClient("none", ownerId);
    const session = {
      sessionKey,
      sessionId,
      agentId: "main",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    };
    const target = { agentId: session.agentId, sessionKey };
    await upsertSessionEntryCore(target, {
      sessionId,
      updatedAt: Date.now(),
      visibility: "draft",
      createdActor: {
        type: "human",
        source: "profile",
        id: expectDefined(owner.authenticatedUserProfile, "wait owner profile").profileId,
      },
    });
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => cfg;
    return { owner, session, target, context, release: catalog.release };
  } catch (error) {
    catalog.release();
    throw error;
  }
}

function nextWaitStarted() {
  const started = createDeferredCore();
  const wait = agentJobs.waitForAgentJob;
  vi.spyOn(agentJobs, "waitForAgentJob").mockImplementationOnce((params) => {
    const pending = wait(params);
    started.resolve();
    return pending;
  });
  return started.promise;
}

function terminalReceipt(runId: string) {
  return {
    runId,
    sessionId: "session-1",
    turnId: "turn-1",
    requested: { provider: "openai", model: "gpt-primary" },
    effective: { provider: "openai", model: "gpt-alternate", responseModel: "gpt-alternate" },
    successfulToolNames: ["read"],
    rerouted: true,
    terminalDisposition: "visible",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function queueFixture(runId: string) {
  const identity = {
    runId,
    agentId: "main",
    sessionKey: "agent:main:queue-admission",
    sessionId: runId,
    storeScope: `/synthetic/agent-wait/${runId}/sessions`,
  };
  const context = createGatewayRequestContext(makeContextParams());
  const publish = (status: "accepted" | "ok") =>
    writeObservation(context.dedupe, runId, { status }, { source: "chat" });
  const bindRun = (source: ReturnType<typeof createRpcSourceForTest>) => {
    const run = createQueueTestRun({ prompt: "queued source" });
    Object.assign(run.run, {
      agentId: identity.agentId,
      sessionKey: identity.sessionKey,
      sessionId: identity.sessionId,
      config: { ...run.run.config, session: { store: identity.storeScope } },
    });
    bindSessionControllerSource(source.input, run);
    return run;
  };
  return { context, identity, publish, bindRun };
}

it("keeps its Gateway when a foreign scope publishes queue admission", async ({ signal }) => {
  const runId = "cross-gateway-queue-publication";
  const { context, identity, bindRun, publish } = queueFixture(runId);
  const resolveGatewayContext = () => context;
  const resolveForeign = () => undefined;
  const source = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
    createRpcSourceForTest({ kind: "chat-send" }, identity),
  );
  const foreign = withPluginRuntimeGatewayContextResolver(resolveForeign, () =>
    createRpcSourceForTest(
      { kind: "chat-send" },
      { ...identity, storeScope: "/synthetic/foreign-queue/sessions" },
    ),
  );
  registerRpcSource(runId, source);
  registerRpcSource(runId, foreign);
  const run = bindRun(source);
  run.turnAdoptionLifecycle = {
    onAdopted: () => {},
    onDeferred: () => publish("accepted"),
  };
  vi.useFakeTimers();
  const waiting = prepareAgentWaitForTurn(
    { dedupe: context.dedupe, resolveGatewayContext },
    { runId, timeoutMs: 30_000 },
  ).wait();
  try {
    withPluginRuntimeGatewayContextResolver(resolveForeign, () => {
      const enqueued = enqueueFollowupRun(
        identity.sessionKey,
        run,
        { mode: "followup" },
        "none",
        undefined,
        false,
      );
      expect(enqueued).toBe(true);
    });
    await expect(withinTest(waiting, signal)).resolves.toMatchObject({
      session: { sessionId: identity.sessionId },
      result: pendingResult(runId),
    });
  } finally {
    publish("ok");
    await waiting;
  }
});

it.each([
  { name: "direct claim waiting", enqueued: false, injecting: false },
  { name: "direct native injection", enqueued: false, injecting: true },
  { name: "enqueued follow-up", enqueued: true, injecting: false },
  { name: "enqueued native injection", enqueued: true, injecting: true },
])("reports admitted queue state: $name", async ({ name, enqueued, injecting }) => {
  const runId = `queue-admission-${name}`;
  const { context, identity, bindRun, publish } = queueFixture(runId);
  let blocker: SessionControllerMailboxClaim | undefined;
  if (!enqueued && !injecting) {
    const blockingSource = createRpcSourceForTest({}, identity);
    blocker = await claimSessionControllerTask(blockingSource.input, () => {});
  }
  const source = createRpcSourceForTest(
    { kind: "chat-send" },
    { ...identity, runId, phase: enqueued && !injecting ? "waiting" : "preparing" },
  );
  rpcSourceTesting.set(runId, source);
  const directClaim = blocker ? claimSessionControllerTask(source.input, () => {}) : undefined;
  const injection =
    injecting && !enqueued ? beginSessionControllerSourceInjection(source.input) : undefined;
  let queuedInjection: ReturnType<typeof reserveSteerCandidate>;
  if (enqueued && injecting) {
    const run = bindRun(source);
    queuedInjection = reserveSteerCandidate(
      identity.sessionKey,
      run,
      { mode: "steer" },
      async () => {},
    );
  }
  const respond = vi.fn();
  let waiting: Promise<void> | void = undefined;
  try {
    if (enqueued && injecting) {
      expect(await queuedInjection?.admit()).toBe("steer");
      queuedInjection?.accepted(true);
    }
    if (injection) {
      expect(await injection.admit()).toBe(true);
      injection.accepted(true);
    }
    vi.useFakeTimers();
    waiting = invokeWait(context, runId, 30_000, null, false, respond).promise;
    await vi.advanceTimersByTimeAsync(0);
    if (enqueued) {
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(pendingResult(runId)));
    } else {
      expect(respond).not.toHaveBeenCalled();
    }
  } finally {
    queuedInjection?.consume("consumed");
    injection?.finish(true);
    if (blocker) {
      releaseSessionControllerClaim(blocker);
    }
    if (directClaim) {
      releaseSessionControllerClaim(await directClaim);
    }
    publish("ok");
    await waiting;
  }
  if (!enqueued) {
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ runId, status: "ok" }));
  }
});

it("keeps whitespace-distinct protocol run IDs separate", async () => {
  const plain = "exact-rpc-id";
  const spaced = " exact-rpc-id ";
  const dedupe = new Map<string, DedupeEntry>();
  completeRun(dedupe, plain);
  const source = createRpcSourceForTest(
    { kind: "agent" },
    {
      runId: spaced,
      sessionKey: "agent:main:exact-rpc",
      sessionId: "exact-session",
      phase: "waiting",
    },
  );
  rpcSourceTesting.reset([[spaced, source]]);
  const service = createAgentTurnService({
    context: { dedupe } as unknown as Parameters<typeof createAgentTurnService>[0]["context"],
    isWebchatConnect: () => false,
  });
  expect((await service.waitForTurn({ runId: spaced, timeoutMs: 0 })).result).toMatchObject({
    runId: spaced,
    status: "pending",
    timeoutPhase: "queue",
  });
  expect((await service.waitForTurn({ runId: plain, timeoutMs: 0 })).result).toMatchObject({
    runId: plain,
    status: "ok",
  });
});

it.each(
  (["ok", "error", "timeout"] as const).flatMap((status) =>
    (["active", "retired", "sessionless"] as const).map((registration) => ({
      status,
      registration,
    })),
  ),
)(
  "waits for replayable $status after execution ends ($registration)",
  async ({ status, registration }) => {
    vi.useFakeTimers();
    const runId = `publication-${status}-${registration}`;
    const key = `agent:${runId}`;
    const context = createGatewayRequestContext(makeContextParams());
    let claim: SessionControllerMailboxClaim | undefined;
    if (registration !== "sessionless") {
      const source = createTestRpcSource(
        { kind: "agent", sessionKey: "agent:main:publication", sessionId: "publication-session" },
        runId,
      );
      rpcSourceTesting.set(runId, source);
      claim = await claimSessionControllerTask(source.input, () => {});
    }
    writeObservation(context.dedupe, runId, { status: "accepted" });
    const replay = () => {
      const emitAcceptance = vi.fn();
      expect(
        replayAgentTurnIfCached({
          preflight: { runId, agentDedupeKeys: [key] },
          context,
          io: { emitAcceptance, emitFinal: vi.fn() },
        }),
      ).toBe(true);
      return emitAcceptance.mock.calls[0]?.[0];
    };
    const terminal = {
      runId,
      status,
      ...(status === "timeout" ? { stopReason: "rpc" } : {}),
      result: { payloads: [{ text: "canonical terminal reply" }] },
    };
    const publish = () =>
      writeObservation(context.dedupe, runId, terminal, { ok: status !== "error" });
    const waiting = invokeWait(context, runId, 60_000);
    try {
      expect(replay()?.[1]).toMatchObject({ runId, status: "in_flight" });
      lifecycle(runId, { phase: "start" });
      lifecycle(runId, { phase: "end", executionSettled: true, ...terminal });
      if (registration === "retired") {
        rpcSourceTesting.delete(runId);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(waiting.respond).not.toHaveBeenCalled();
      const duringPublication = invokeWait(context, runId, 0);
      await expectReply(duringPublication, { runId, status: "timeout" });
      expect(replay()?.[1]).toMatchObject({ runId, status: "in_flight" });
      publish();
      rpcSourceTesting.delete(runId);
      await expectReply(
        waiting,
        expect.objectContaining({ runId, status: status === "timeout" ? "error" : status }),
      );
      expect(replay()).toEqual([status !== "error", terminal, undefined]);
      const afterCleanup = invokeWait(context, runId, 0);
      await afterCleanup.promise;
      expect(afterCleanup.respond.mock.calls).toEqual(waiting.respond.mock.calls);
    } finally {
      publish();
      await waiting.promise;
      rpcSourceTesting.clear();
      if (claim) {
        releaseSessionControllerClaim(claim);
      }
    }
  },
);

it.each([undefined, true] as const)(
  "retires a sticky terminal only for an admitted new attempt: %s",
  async (startNewAttempt) => {
    const { runId, dedupe, write, job, complete } = runFixture();
    const key = `agent:${runId}`;
    write(
      { status: "timeout", stopReason: "restart" },
      { ts: 100, requestIdentity: "original-input-binding" },
    );
    write({ status: "ok" }, { ts: 150, startNewAttempt: true });
    expect(dedupe.get(key)?.payload).toMatchObject({ status: "timeout", stopReason: "restart" });
    write(
      { status: "accepted", reservationId: "new-admission" },
      { ts: 200, startNewAttempt, requestIdentity: "replacement-must-not-change-binding" },
    );
    expect(dedupe.get(key)).toMatchObject({
      requestIdentity: "original-input-binding",
      payload: { status: startNewAttempt ? "accepted" : "timeout" },
    });
    const observed = await job();
    if (startNewAttempt) {
      expect(observed).toBeNull();
      complete();
      expect(await job()).toMatchObject({ status: "ok" });
    } else {
      expect(observed).toMatchObject({ status: "error", stopReason: "restart" });
    }
  },
);

it("expires terminal observations from their latest write without extending unrelated runs", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const dedupe = new Map<string, DedupeEntry>();
  completeRun(dedupe, "cache-refreshed");
  completeRun(dedupe, "cache-original");
  vi.setSystemTime(1_000_100);
  completeRun(dedupe, "cache-refreshed");
  // Wall-clock correction can insert an earlier expiry after newer records.
  vi.setSystemTime(999_900);
  completeRun(dedupe, "cache-clock-correction");

  for (const [now, expected] of [
    [1_599_900, ["ok", "ok", "ok"]],
    [1_599_901, ["ok", "ok", "timeout"]],
    [1_600_000, ["ok", "ok", "timeout"]],
    [1_600_001, ["ok", "timeout", "timeout"]],
    [1_600_100, ["ok", "timeout", "timeout"]],
    [1_600_101, ["timeout", "timeout", "timeout"]],
  ] as const) {
    vi.setSystemTime(now);
    const runIds = ["cache-refreshed", "cache-original", "cache-clock-correction"];
    for (const [index, runId] of runIds.entries()) {
      await expectReply(
        waitThroughGateway({ runId, timeoutMs: 0 }),
        expect.objectContaining({ runId, status: expected[index] }),
      );
    }
  }
});

it("keeps visible queued waits available after the terminal observation expires", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { owner, session, context, release } = await ownedWaitSession(
      "agent:main:queued-visible",
      "queued-visible-session",
      "queued-owner",
    );
    using _ = { [Symbol.dispose]: release };
    const other = roleClient("none", "queued-other");
    const runId = "queued-visible-wait";
    rpcSourceTesting.clear();
    const source = createRpcSourceForTest({}, { ...session, runId, phase: "waiting" });
    const controller = testRpcSourceController(source);
    const invoke = async (client: typeof owner) => {
      const invocation = invokeWait(context, runId, 0, client, true);
      await invocation.promise;
      return invocation.respond;
    };
    try {
      vi.useFakeTimers();
      vi.setSystemTime(2_000_000);
      rpcSourceTesting.set(runId, source);
      writeObservation(new Map(), runId, { status: "ok" }, { source: "chat", session });
      const expected = pendingResult(runId);
      expect(await invoke(owner)).toHaveBeenCalledWith(true, expected);
      vi.setSystemTime(2_600_001);
      expect(await invoke(owner)).toHaveBeenCalledWith(true, expected);
      expect(await invoke(other)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "agent run was not found" }),
      );
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });
});

it.each(["compaction", "replacement"] as const)(
  "keeps a pending wait bound to its original registration after %s",
  async (transition) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { owner, session, target, context, release } = await ownedWaitSession(
        "agent:main:timeout-rotation",
        "original-session",
        "timeout-owner",
      );
      using _ = { [Symbol.dispose]: release };
      const runId = `wait-timeout-${transition}`;
      registerAgentRunContext(runId, session);
      const respond = vi.fn();
      const started = nextWaitStarted();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { promise: waiting } = invokeWait(context, runId, 10, owner, true, respond);
      try {
        await started;
        expect(respond).not.toHaveBeenCalled();
        await upsertSessionEntryCore(target, { sessionId: "successor-session" });
        if (transition === "replacement") {
          clearAgentRunContext(runId);
        }
        registerAgentRunContext(runId, { ...session, sessionId: "successor-session" });
        await vi.advanceTimersByTimeAsync(10);
        await waiting;
        if (transition === "compaction") {
          expect(respond).toHaveBeenCalledWith(true, { runId, status: "timeout" });
        } else {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ message: "agent run was not found" }),
          );
        }
      } finally {
        await vi.advanceTimersByTimeAsync(10);
        await waiting;
        clearAgentRunContext(runId);
        vi.useRealTimers();
      }
    });
  },
);

it.each([
  ["agent", "timeout"],
  ["chat", "ok"],
] as const)("uses the %s abort entry to select the run observation", async (kind, status) => {
  const { runId, write, wait } = runFixture();
  write({ status: "timeout", endedAt: 100, timeoutPhase: "provider" }, { ts: 100, ok: false });
  write({ status: "ok", endedAt: 200 }, { ts: 200, source: "chat" });

  await expectReply(wait(0, kind), expect.objectContaining({ runId, status }));
});

it("binds queued observation to the queue entry selected after waiting", async () => {
  const runId = "queued-observation-session";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const original = {
    sessionKey: "agent:main:original",
    sessionId: "original-session",
    agentId: "main",
    lifecycleGeneration,
  };
  writeObservation(new Map(), runId, { status: "ok" }, { session: original });
  rpcSourceTesting.clear();
  const service = createAgentTurnService({
    context: {
      dedupe: new Map(),
    } as unknown as Parameters<typeof createAgentTurnService>[0]["context"],
    isWebchatConnect: () => false,
  });
  const selected = service.waitForTurn({ runId, timeoutMs: 0 });
  const queued = { sessionKey: "agent:main:queued", sessionId: "queued-session", agentId: "main" };
  const source = createRpcSourceForTest({}, { ...queued, runId, phase: "waiting" });
  const controller = testRpcSourceController(source);
  try {
    rpcSourceTesting.set(runId, source);
    await expect(selected).resolves.toEqual({
      session: { ...queued, lifecycleGeneration },
      result: pendingResult(runId),
    });
  } finally {
    controller.abort();
    await selected;
  }
});

it("observes later queue admission without completing terminal or another Gateway's waits", async () => {
  vi.useFakeTimers();
  const runId = "queued-after-wait";
  const context = createGatewayRequestContext(makeContextParams());
  const otherContext = createGatewayRequestContext(makeContextParams());
  context.resolveGatewayContext = () => context;
  otherContext.resolveGatewayContext = () => otherContext;
  const service = createAgentTurnService({ context, isWebchatConnect: () => false });
  const otherService = createAgentTurnService({
    context: otherContext,
    isWebchatConnect: () => false,
  });
  const queuedObserved = vi.fn();
  const terminalObserved = vi.fn();
  const otherObserved = vi.fn();
  const queuedWait = service.waitForTurn({ runId, timeoutMs: 30_000 }).then(queuedObserved);
  const terminalWait = waitForAgentJob({ runId, timeoutMs: 30_000, source: "chat" }).then(
    terminalObserved,
  );
  const otherWait = otherService.waitForTurn({ runId, timeoutMs: 30_000 }).then(otherObserved);
  let queuedSource: RpcSourceRef | undefined;
  const session = {
    sessionKey: "agent:main:queued-after-wait",
    sessionId: "queued-after-wait-session",
    agentId: "main",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
  };
  try {
    queuedSource = createRpcSourceForTest(
      { kind: "chat-send" },
      { runId, ...session, phase: "waiting" },
    );
    bindGatewayContextResolver(queuedSource.input, context.resolveGatewayContext);
    rpcSourceTesting.set(runId, queuedSource);
    writeObservation(context.dedupe, runId, { status: "accepted" }, { source: "chat", session });
    await vi.advanceTimersByTimeAsync(0);
    expect(queuedObserved).toHaveBeenCalledWith({ session, result: pendingResult(runId) });
    expect(terminalObserved).not.toHaveBeenCalled();
    expect(otherObserved).not.toHaveBeenCalled();
  } finally {
    if (queuedSource) {
      testRpcSourceController(queuedSource).abort();
    }
    completeRun(context.dedupe, runId, "chat");
    await Promise.all([queuedWait, terminalWait, otherWait]);
  }
});

it.each([undefined, "agent", "chat"] as const)(
  "resolves concurrent %s waiters when the terminal dedupe entry lands",
  async (source) => {
    const { runId, wait, complete } = runFixture();
    const first = wait(1_000, source);
    const second = wait(1_000, source);

    await Promise.resolve();
    complete(source);
    await Promise.all([first.promise, second.promise]);

    const expected = {
      runId,
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      error: undefined,
      stopReason: undefined,
      livenessState: undefined,
      yielded: undefined,
      pendingError: undefined,
      timeoutPhase: undefined,
      providerStarted: undefined,
    };
    expect(first.respond).toHaveBeenCalledWith(true, expected);
    expect(second.respond).toHaveBeenCalledWith(true, expected);
  },
);

it("retires only its scope's observer without ending the shared run", async () => {
  const { runId, complete, job } = runFixture();
  const observer = () => {
    const scope = new AsyncWorkScope();
    const settled = vi.fn();
    const wait = scope
      .track(() => waitForAgentJob({ runId, timeoutMs: 600_000 }))
      .then((result) => {
        settled();
        return result;
      });
    return { scope, settled, wait };
  };
  const first = observer();
  const second = observer();
  try {
    first.scope.beginClose();
    await nextTurn();
    expect(first.settled).toHaveBeenCalledOnce();
    expect(second.settled).not.toHaveBeenCalled();
    expect(await first.wait).toBeNull();
    complete();
    await expect(second.wait).resolves.toMatchObject({ status: "ok", endedAt: 200 });
    await expect(job()).resolves.toMatchObject({ status: "ok", endedAt: 200 });
  } finally {
    // The old owner has no shutdown observer: release it without waiting ten minutes.
    if (!first.settled.mock.calls.length || !second.settled.mock.calls.length) {
      complete();
    }
    await Promise.all([first.wait, second.wait, first.scope.drain(), second.scope.drain()]);
  }
});

it.each([
  { activeKind: undefined, timeoutMs: 0, reset: false },
  { activeKind: "agent", timeoutMs: 10, reset: false },
  { activeKind: "chat", timeoutMs: 10, reset: false },
  { activeKind: undefined, timeoutMs: 1_000, reset: true },
] as const)(
  "keeps $activeKind observation interruption nonterminal (timeout=$timeoutMs, reset=$reset)",
  async ({ activeKind, timeoutMs, reset }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { runId, wait, complete } = runFixture();
    const started = nextWaitStarted();
    const timedOut = wait(timeoutMs, activeKind);
    await started;
    if (reset) {
      // Native worker shutdown joins its exit through setImmediate.
      vi.useRealTimers();
      await drainGlobalSingletonLifecycleState("restart");
    } else {
      await vi.advanceTimersByTimeAsync(timeoutMs);
    }
    await expectReply(timedOut, {
      runId,
      status: "timeout",
      ...(reset ? { timeoutPhase: "gateway_draining" } : {}),
    });
    await expectReply(wait(0, activeKind), { runId, status: "timeout" });
    complete(activeKind);
    await expectReply(
      wait(0, activeKind),
      expect.objectContaining({ runId, status: "ok", endedAt: 200 }),
    );
  },
);

it.each([
  ["late completion", { status: "ok", endedAt: 300 }, hardTimeout],
  ["earlier cancellation", userCancellation, userCancellation],
] as const)("merges %s across agent and chat observations", async (_name, payload, expected) => {
  for (const timeoutFirst of [true, false]) {
    const { runId, write, wait } = runFixture();
    const timeout = () => write({ ...hardTimeout, startedAt: 100 }, { ts: 200, ok: false });
    const other = () =>
      write(
        { ...payload, startedAt: 100 },
        { ts: 300, ok: payload.status === "ok", source: "chat" },
      );
    for (const observe of timeoutFirst ? [timeout, other] : [other, timeout]) {
      observe();
    }
    await expectReply(wait(), expect.objectContaining({ runId, ...expected }));
  }
});

it.each(["lifecycle-first", "dedupe-first"] as const)(
  "keeps terminal evidence when sticky status arrives $0",
  async (order) => {
    const { runId, write, wait } = runFixture();
    lifecycle(runId, { phase: "start", startedAt: 100 });
    const lifecycleEnd = () =>
      lifecycle(runId, {
        phase: "end",
        startedAt: 100,
        endedAt: 300,
        terminalDelivery: { status: "sent", resultCount: 1, target: "private-target" },
        terminalReceipt: terminalReceipt(runId),
        terminalReply: { disposition: "visible", text: "canonical reply" },
      });
    const dedupeTimeout = () => write({ ...hardTimeout, startedAt: 100 }, { ts: 200, ok: false });

    for (const observe of order === "lifecycle-first"
      ? [lifecycleEnd, dedupeTimeout]
      : [dedupeTimeout, lifecycleEnd]) {
      observe();
    }

    const waiter = wait();
    await expectReply(
      waiter,
      expect.objectContaining({
        runId,
        status: "timeout",
        terminalDelivery: { status: "sent", resultCount: 1 },
        terminalReceipt: terminalReceipt(runId),
        terminalReply: { disposition: "visible", text: "canonical reply" },
      }),
    );
    expect(JSON.stringify(waiter.respond.mock.calls[0]?.[1])).not.toContain("private-target");
  },
);
