import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { GatewayRequestEntryLifetime } from "../server-request-entry.js";
import { createRpcSourceForTest, claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { expectCalls } from "./agent-owner.test-support.js";
import { createInternalAgentTurnFacade } from "./internal-facade.js";
import type { AgentTurnStartOwner } from "./internal-facade.types.js";
import { setTestRpcSourceIdentity } from "./rpc-source.test-support.js";
import type { AgentTurnIo } from "./types.js";

const startTurn = vi.hoisted(() => vi.fn());
const waitForTurn = vi.hoisted(() => vi.fn());
const authorize = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const envelope = vi.hoisted(() => vi.fn(async (run: () => Promise<unknown>) => await run()));

vi.mock("../server-methods.js", () => ({
  createRequestGatewayMethodRegistry: () => ({
    isControlPlaneWrite: () => false,
    isObservation: (method: string) => method === "agent.wait",
  }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await envelope(run),
}));

vi.mock("../server-methods/request-authorization.js", () => ({
  authorizeGatewayRequestPreDispatch: authorize,
}));

vi.mock("./agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));

const service = () => ({ createAgentTurnService: () => ({ startTurn, waitForTurn }) });
vi.mock("./agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn }),
}));

function createContext() {
  return Object.assign({} as GatewayRequestContext, {
    trackExecution: trackAsyncWork,
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
    nodeSendToSession: vi.fn(),
    removeChatRun: vi.fn(() => undefined),
  });
}

function createFacade(context = createContext(), assertContextCurrent?: () => void) {
  return createInternalAgentTurnFacade({
    client: createSyntheticPluginRuntimeClient(),
    getContext: () => context,
    assertContextCurrent,
  });
}

type Facade = ReturnType<typeof createFacade>;
function requestTurn(
  runId: string,
  options: NonNullable<Parameters<Facade["dispatchRaw"]>[1]> = {},
  facade = createFacade(),
  method: "dispatch" | "wait" = "dispatch",
) {
  return method === "dispatch"
    ? facade.dispatchRaw({ message: "test", idempotencyKey: runId }, options)
    : facade.wait({ runId, timeoutMs: 0 }, options.timeoutMs, options.signal);
}

function executionFixture() {
  const scope = new AsyncWorkScope();
  const entries = new GatewayRequestEntryLifetime();
  const executions: Promise<unknown>[] = [];
  const context = Object.assign(createContext(), {
    requestEntryLifetime: entries,
    trackExecution: <T>(run: () => Promise<T>) => {
      const execution = scope.track(run);
      executions.push(execution);
      return execution;
    },
  });
  return { scope, entries, executions, context };
}

function accept(
  io: AgentTurnIo,
  runId: string,
  meta?: Parameters<AgentTurnIo["emitAcceptance"]>[1],
) {
  io.emitAcceptance([true, { runId, status: "accepted" }, undefined], meta);
}

function registerRun(
  runId: string,
  sessionId: string,
  sessionKey: string,
  agentId?: string,
  incarnation?: string,
) {
  return registerChatAbortController({
    agentId,
    runId,
    sessionId,
    sessionKey,
    kind: "agent",
    timeoutMs: 60_000,
    target: captureSessionTarget({ storeScope: "/synthetic/facade.db", sessionKey, incarnation }),
  });
}

async function startOwnerFixture(assertContextCurrent?: () => void) {
  const request = {
    agentId: "main",
    message: "resume",
    idempotencyKey: "owned-start",
    sessionKey: "agent:main:owned-start",
    expectedExistingSessionId: "owned-session",
  };
  const register = () =>
    registerRun(
      request.idempotencyKey,
      request.expectedExistingSessionId,
      request.sessionKey,
      request.agentId,
      request.expectedExistingSessionId,
    );
  const registration = register();
  assert(registration.registered, "expected startup registration");
  onTestFinished(registration.cleanup);
  const onStartOwner = vi.fn<(owner: AgentTurnStartOwner) => void>();
  startTurn.mockImplementation(async ({ io }) => {
    io.emitStartOwner?.(request.idempotencyKey, registration.entry);
    accept(io, request.idempotencyKey, { runId: request.idempotencyKey });
  });
  await createFacade(createContext(), assertContextCurrent).dispatch(request, { onStartOwner });
  const owner = expectDefined(onStartOwner.mock.calls[0]?.[0], "captured startup owner");
  return { request, register, registration, owner };
}

beforeEach(() => {
  resetAgentEventsForTest();
  startTurn.mockReset();
  waitForTurn.mockReset();
  authorize.mockReset().mockResolvedValue({ error: null });
  envelope.mockReset().mockImplementation(async (run) => await run());
});

it.for([
  ["cold", "close", "dispatch"],
  ["cold", "close", "wait"],
  ["cold", "abort", "dispatch"],
  ["cold", "abort", "wait"],
  ["cold", "admission", "dispatch"],
  ["cold", "context", "dispatch"],
  ["cold", "deadline", "dispatch"],
  ["cold", "deadline", "wait"],
  ["authorization", "abort", "dispatch"],
  ["authorization", "abort", "wait"],
  ["authorization", "revoke", "dispatch"],
  ["envelope", "revoke", "dispatch"],
  ["preparation", "abort", "dispatch"],
  ["preparation", "reject", "dispatch"],
] as const)("joins %s and rechecks %s (%s)", async ([stage, boundary, method], { signal }) => {
  const held = createDeferred();
  const reached = createDeferred();
  const pause = () => {
    reached.resolve();
    return held.promise;
  };
  const cold = stage === "cold";
  const authorizationAbort = stage === "authorization" && boundary === "abort";
  const releaseMutation = vi.fn();
  const releaseAccess = vi.fn();
  if (cold) {
    // Each case drains its execution before replacing the mocked import.
    vi.resetModules();
    startTurn.mockImplementation(async ({ io }) => accept(io, "guarded-run"));
    waitForTurn.mockResolvedValue({ result: { status: "timeout" } });
    // mock-isolation: Hold service loading at the cold-admission boundary without real runtime state.
    vi.doMock("./agent-turn-service.js", async () => {
      await pause();
      return service();
    });
  } else if (stage === "authorization") {
    authorize.mockImplementationOnce(async () => {
      await pause();
      return {
        error: null,
        ...(authorizationAbort
          ? {
              sessionMutationAuthorization: { release: releaseMutation },
              sessionAccessAuthority: { release: releaseAccess },
            }
          : {}),
      };
    });
  } else if (stage === "envelope") {
    envelope.mockImplementationOnce(async (run) => {
      await pause();
      return run();
    });
  }
  const unblock = () => held.resolve();
  signal.addEventListener("abort", unblock, { once: true });
  const { scope, entries, executions, context } = executionFixture();
  const authority = new AbortController();
  const assertCurrent = () => authority.signal.throwIfAborted();
  const facade = createFacade(context, boundary === "context" ? assertCurrent : undefined);
  const message = {
    deadline: `gateway request timeout for ${method === "dispatch" ? "agent" : "agent.wait"}`,
    close: "Gateway request entry is closed",
    abort: "caller canceled",
    admission: "caller retired",
    context: "caller retired",
    revoke: "source closed",
    reject: "source preparation failed",
  }[boundary];
  const reason = new Error(message);
  const controller = new AbortController();
  const request = requestTurn(
    "guarded-run",
    {
      signal: controller.signal,
      ...(boundary === "deadline" ? { timeoutMs: 0, cancelOnDeadline: false } : {}),
      ...(!cold || boundary === "admission" ? { assertAdmissionCurrent: assertCurrent } : {}),
      ...(stage === "preparation" ? { prepareDispatchCurrent: pause } : {}),
    },
    facade,
    method,
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const settled: string[] = [];
  let joins: Promise<unknown>[] = [];
  try {
    await reached.promise;
    if (boundary === "deadline") {
      await request;
    } else if (boundary === "close") {
      entries.beginClose();
    } else if (boundary === "abort") {
      controller.abort(reason);
      if (stage === "preparation") {
        expect(await request).toEqual({ error: reason });
      }
    } else if (boundary === "reject") {
      held.reject(reason);
    } else {
      authority.abort(reason);
    }
    if (cold) {
      joins = [
        entries.waitForPendingEntries().then(() => settled.push("entry")),
        AsyncWorkScope.runWhenAllIdle(
          () => [scope],
          () => scope.drain(),
        ).then(() => settled.push("execution")),
      ];
      await nextTurn();
      expect.soft(settled, `${method}/${boundary} joins`).toEqual([]);
    }
    unblock();
    const outcome = await request;
    await Promise.all(joins);
    expect(outcome, `${method}/${boundary} caller`).toEqual({
      error: expect.objectContaining({ message }),
    });
    if (authorizationAbort && "error" in outcome) {
      expect(outcome.error).toBe(reason);
    }
    if (cold) {
      expect(executions).toHaveLength(1);
    }
    if (boundary === "deadline") {
      await expect(executions[0]).resolves.toEqual(
        method === "dispatch" ? undefined : { status: "timeout" },
      );
    } else {
      if (cold) {
        await expect(executions[0]).rejects.toThrow(
          method === "wait" && boundary === "abort" ? "agent.wait observation cancelled" : message,
        );
      }
      expectCalls(0, startTurn, waitForTurn);
    }
    await scope.drain();
    await entries.waitForPendingEntries();
    expect(scope.hasPendingWork).toBe(false);
    if (authorizationAbort) {
      expectCalls(1, releaseMutation, releaseAccess);
      expect(envelope).not.toHaveBeenCalled();
    }
  } finally {
    unblock();
    await Promise.allSettled([request, ...joins]);
    await scope.drain();
    signal.removeEventListener("abort", unblock);
    if (cold) {
      // mock-isolation: Restore the controlled turn service after each cold import.
      vi.doMock("./agent-turn-service.js", service);
      vi.resetModules();
    }
  }
});

it("keeps selected wait session facts private", async () => {
  const result = { runId: "completed-run", status: "ok" };
  waitForTurn.mockResolvedValue({
    result,
    session: {
      sessionKey: "agent:main:original",
      sessionId: "original-session",
      lifecycleGeneration: "original-generation",
    },
  });
  await expect(createFacade().wait({ runId: "completed-run" })).resolves.toEqual(result);
});

it.each(["final", "error"])(
  "preserves acceptance ordering and the post-acceptance %s",
  async (completion) => {
    const authority = new AbortController();
    const assertAdmissionCurrent = () => authority.signal.throwIfAborted();
    const accepted = createDeferred();
    const { promise: finalGate, resolve: emitFinal } = createDeferred();
    const dispatchError = new Error("turn failed");
    const payload = { runId: "run-1", status: "ok", summary: "done" };
    const meta = { runId: "run-1", terminal: true };
    startTurn.mockImplementation(async ({ io, assertAdmissionCurrent: admissionGuard }) => {
      admissionGuard();
      accept(io, "run-1", { runId: "run-1" });
      await finalGate;
      if (completion === "error") {
        throw dispatchError;
      }
      io.emitFinal([true, payload, undefined], meta);
    });
    const onAccepted = vi.fn(() => accepted.resolve());

    const result = requestTurn("run-1", { expectFinal: true, onAccepted, assertAdmissionCurrent });
    await accepted.promise;
    expect(onAccepted).toHaveBeenCalledWith({ runId: "run-1", status: "accepted" });
    authority.abort(new Error("source closed"));
    emitFinal();

    if (completion === "error") {
      await expect(result).rejects.toBe(dispatchError);
    } else {
      await expect(result).resolves.toEqual({ ok: true, payload, error: undefined, meta });
    }
  },
);

it.each([
  { cached: false, executing: true },
  { cached: true, executing: false },
  { cached: true, executing: true },
])(
  "reports actual execution (cached=$cached, executing=$executing)",
  async ({ cached, executing }) => {
    if (cached) {
      const source = createRpcSourceForTest({}, { runId: "run-2" });
      rpcSourceTesting.set("run-2", source);
      if (executing) {
        await claimRpcSourceForTest(source);
      }
    }
    const onExecutionStarted = vi.fn();
    const payload = { runId: "run-2", status: "in_flight" };
    const meta = { cached: true, runId: "run-2" };
    startTurn.mockImplementation(async ({ io }) => {
      if (cached) {
        io.emitAcceptance([true, payload, undefined], meta);
      } else {
        accept(io, "run-2");
        io.emitExecutionStarted?.();
      }
    });
    await requestTurn("run-2", { onExecutionStarted });
    expect(onExecutionStarted).toHaveBeenCalledTimes(executing ? 1 : 0);
  },
);

it.each([
  "aborted",
  "replaced",
  "rotated",
  "agent changed",
  "session changed",
  "gateway closed",
] as const)("retires startup ownership when %s", async (change) => {
  const gateway = new AbortController();
  const { registration, register, owner } = await startOwnerFixture(() =>
    gateway.signal.throwIfAborted(),
  );
  let replacement: ReturnType<typeof register> | undefined;
  const invalidate = {
    aborted: () => registration.controller.abort(),
    replaced: () => {
      registration.cleanup();
      replacement = register();
      onTestFinished(replacement.cleanup);
    },
    rotated: rotateAgentEventLifecycleGeneration,
    "agent changed": () => setTestRpcSourceIdentity(registration.entry, { agentId: "other-agent" }),
    "session changed": () =>
      setTestRpcSourceIdentity(registration.entry, { sessionId: "replacement-session" }),
    "gateway closed": () => gateway.abort(new Error("gateway closed")),
  };
  expect(owner.observe()).toEqual({ executionStarted: false });
  invalidate[change]();
  expect(owner.observe()).toBeUndefined();
  expect(owner.abort()).toBe(false);
  expect(replacement?.controller.signal.aborted ?? false).toBe(false);
});

it("captures startup identity independently of the mutable request", async () => {
  const { request, registration, owner } = await startOwnerFixture();
  Object.assign(request, {
    agentId: "other-agent",
    idempotencyKey: "other-run",
    sessionKey: "agent:other:other",
    expectedExistingSessionId: "other-session",
  });
  expect(owner.observe()).toBeDefined();
  expect(owner.abort()).toBe(true);
  expect(registration.controller.signal.aborted).toBe(true);
});

it("observes a started owner without reentering its watchdog authority", async () => {
  const { owner, registration } = await startOwnerFixture();
  const observation = owner.observe();
  expect(observation).toEqual({ executionStarted: false });
  expect(() => Reflect.get(observation ?? {}, "expiresAtMs")).toThrowError(
    expect.objectContaining({
      code: "PLUGIN_CAPABILITY_REMOVED",
      capability: "startOwner.observe().expiresAtMs",
      message: expect.stringContaining("startDeadlineAtMs"),
    }),
  );
  await claimRpcSourceForTest(registration.entry);
  const operation = expectDefined(registration.entry.input.claim?.operation, "claimed operation");
  let policyCurrent = true;
  let validatingPolicy = false;
  const assertCurrent = vi.fn(() => {
    assert(!validatingPolicy, "Start observation reentered effect authority");
    validatingPolicy = true;
    try {
      assert(policyCurrent, "Recovery operator policy revoked");
      expect(owner.observe()).toMatchObject({ executionStarted: true });
    } finally {
      validatingPolicy = false;
    }
  });
  const attempt = operation.watchdog.attachAttempt({ assertCurrent });
  using cleanup = new DisposableStack();
  cleanup.defer(() => attempt.close());
  assertCurrent.mockClear();
  expect(owner.observe()).toMatchObject({ executionStarted: true });
  expect(assertCurrent).not.toHaveBeenCalled();
  expect(owner.abort()).toBe(false);
  expect(attempt.isCurrent()).toBe(true);
  policyCurrent = false;
  expect(attempt.isCurrent()).toBe(false);
});

it.each([false, true])(
  "cancels only its accepted run across the dispatch deadline (late acceptance: %s)",
  async (lateAcceptance) => {
    vi.useFakeTimers();
    const acceptanceGate = createDeferred();
    const acceptanceReached = createDeferred();
    const unrelated = registerRun("unrelated-run", "unrelated-session", "agent:main:unrelated");
    let accepted: ReturnType<typeof registerChatAbortController> | undefined;
    onTestFinished(() => {
      accepted?.cleanup();
      unrelated.cleanup();
    });
    startTurn.mockImplementation(async ({ io }) => {
      if (lateAcceptance) {
        await acceptanceGate.promise;
      }
      const registration = registerRun("deadline-run", "deadline-session", "agent:main:deadline");
      accepted = registration;
      accept(io, "deadline-run", { runId: "deadline-run" });
      acceptanceReached.resolve();
      if (!lateAcceptance) {
        await once(registration.controller.signal, "abort");
        throw new Error("deadline run aborted");
      }
    });

    try {
      const result = createFacade().dispatchRaw(
        {
          message: "settle requester",
          sessionKey: "agent:main:deadline",
          idempotencyKey: "deadline-run",
        },
        { cancelOnDeadline: true, expectFinal: true, timeoutMs: 20 },
      );
      const outcome = expect(result).rejects.toThrow("gateway request timeout for agent");
      if (!lateAcceptance) {
        await acceptanceReached.promise;
      }
      await vi.advanceTimersByTimeAsync(20);

      await outcome;
      if (lateAcceptance) {
        acceptanceGate.resolve();
        await acceptanceReached.promise;
      }
      expect(accepted?.controller.signal.aborted).toBe(true);
      expect(unrelated.controller.signal.aborted).toBe(false);
    } finally {
      acceptanceGate.resolve();
      vi.useRealTimers();
    }
  },
);
