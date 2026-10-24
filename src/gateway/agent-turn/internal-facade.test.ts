import assert from "node:assert/strict";
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
import { createInternalAgentTurnFacade } from "./internal-facade.js";
import type { AgentTurnStartOwner } from "./internal-facade.types.js";
import { setTestRpcSourceIdentity } from "./rpc-source.test-support.js";
import type { AgentTurnIo } from "./types.js";

const startTurn = vi.hoisted(() => vi.fn());
const waitForTurn = vi.hoisted(() => vi.fn());
const runtimeLoad = vi.hoisted(() => ({ loaded: false }));
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

vi.mock("./agent-turn-service.js", () => {
  runtimeLoad.loaded = true;
  return { createAgentTurnService: () => ({ startTurn, waitForTurn }) };
});

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
  return { request, register, registration, onStartOwner, owner };
}

beforeEach(() => {
  resetAgentEventsForTest();
  startTurn.mockReset();
  waitForTurn.mockReset();
  authorize.mockReset().mockResolvedValue({ error: null });
  envelope.mockReset().mockImplementation(async (run) => await run());
});

it("joins cold execution preparation and rechecks closed or canceled callers", async ({
  signal,
}) => {
  expect(runtimeLoad.loaded).toBe(false);
  const scenarios = [
    ["dispatch", "close"],
    ["wait", "close"],
    ["dispatch", "abort"],
    ["wait", "abort"],
    ["dispatch", "admission"],
    ["dispatch", "context"],
    ["dispatch", "deadline"],
    ["wait", "deadline"],
  ] as const;
  try {
    for (const [method, boundary] of scenarios) {
      // Vitest's manual factory callstack cannot represent overlapping cold imports.
      // Join each real execution owner before replacing the next module instance.
      vi.resetModules();
      startTurn.mockReset().mockImplementation(async ({ io }) => {
        io.emitAcceptance([true, { runId: "cold-run" }, undefined]);
      });
      waitForTurn.mockReset().mockResolvedValue({ result: { status: "timeout" } });
      const held = createDeferred();
      const reached = createDeferred();
      vi.doMock("./agent-turn-service.js", async () => {
        reached.resolve();
        await held.promise;
        return { createAgentTurnService: () => ({ startTurn, waitForTurn }) };
      });
      const unblock = () => held.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      const { scope, entries, executions, context } = executionFixture();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("caller retired");
        }
      };
      const facade = createFacade(context, boundary === "context" ? assertCurrent : undefined);
      const controller = new AbortController();
      const request = requestTurn(
        "cold-run",
        {
          signal: controller.signal,
          ...(boundary === "deadline" ? { timeoutMs: 0, cancelOnDeadline: false } : {}),
          ...(boundary === "admission" ? { assertAdmissionCurrent: assertCurrent } : {}),
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
          controller.abort(new Error("caller canceled"));
        } else {
          current = false;
        }
        joins = [
          entries.waitForPendingEntries().then(() => settled.push("entry")),
          AsyncWorkScope.runWhenAllIdle(
            () => [scope],
            () => scope.drain(),
          ).then(() => settled.push("execution")),
        ];
        await nextTurn();
        expect.soft(settled, `${method}/${boundary} joins`).toEqual([]);
        unblock();
        const outcome = await request;
        await Promise.all(joins);
        const message =
          boundary === "deadline"
            ? `gateway request timeout for ${method === "dispatch" ? "agent" : "agent.wait"}`
            : boundary === "close"
              ? "Gateway request entry is closed"
              : boundary === "abort"
                ? "caller canceled"
                : "caller retired";
        expect(outcome, `${method}/${boundary} caller`).toEqual({
          error: expect.objectContaining({ message }),
        });
        const executionMessage =
          method === "wait" && boundary === "abort" ? "agent.wait observation cancelled" : message;
        expect(await Promise.allSettled(executions), `${method}/${boundary} execution`).toEqual([
          boundary === "deadline"
            ? {
                status: "fulfilled",
                value: method === "dispatch" ? undefined : { status: "timeout" },
              }
            : {
                status: "rejected",
                reason: expect.objectContaining({ message: executionMessage }),
              },
        ]);
        expect(startTurn).toHaveBeenCalledTimes(
          boundary === "deadline" && method === "dispatch" ? 1 : 0,
        );
        expect(waitForTurn).toHaveBeenCalledTimes(
          boundary === "deadline" && method === "wait" ? 1 : 0,
        );
        expect(scope.hasPendingWork).toBe(false);
      } finally {
        unblock();
        await Promise.allSettled([request, ...joins]);
        await scope.drain();
        signal.removeEventListener("abort", unblock);
      }
    }
  } finally {
    vi.doMock("./agent-turn-service.js", () => ({
      createAgentTurnService: () => ({ startTurn, waitForTurn }),
    }));
    vi.resetModules();
  }
});

it.each([
  ["authorization", "abort", "dispatch"],
  ["authorization", "abort", "wait"],
  ["authorization", "revoke", "dispatch"],
  ["envelope", "revoke", "dispatch"],
  ["preparation", "abort", "dispatch"],
  ["preparation", "close", "dispatch"],
  ["preparation", "revoke", "dispatch"],
  ["preparation", "reject", "dispatch"],
] as const)("rechecks %s after %s (%s)", async (stage, outcome, method) => {
  const entered = createDeferred();
  const prepared = createDeferred();
  const { scope, entries, context } = executionFixture();
  const controller = new AbortController();
  const releaseMutation = vi.fn();
  const releaseAccess = vi.fn();
  const authorizationAbort = stage === "authorization" && outcome === "abort";
  const message =
    outcome === "close"
      ? "Gateway request entry is closed"
      : outcome === "abort"
        ? authorizationAbort
          ? "caller canceled during authorization"
          : "source aborted"
        : outcome === "reject"
          ? "source preparation failed"
          : stage === "preparation"
            ? "source revoked"
            : "source closed";
  const reason = new Error(message);
  let current = true;
  const pause = () => {
    entered.resolve();
    return prepared.promise;
  };
  if (stage === "authorization") {
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
  const request = requestTurn(
    "guarded-source",
    {
      signal: controller.signal,
      ...(stage === "preparation" ? { prepareDispatchCurrent: pause } : {}),
      assertAdmissionCurrent: () => {
        if (!current) {
          throw reason;
        }
      },
    },
    createFacade(context),
    method,
  );
  const rejected = authorizationAbort
    ? expect(request).rejects.toBe(reason)
    : expect(request).rejects.toThrow(message);
  try {
    await entered.promise;
    expect(startTurn).not.toHaveBeenCalled();
    if (outcome === "abort") {
      controller.abort(reason);
      if (stage === "preparation") {
        await rejected;
      }
    } else if (outcome === "close") {
      entries.beginClose();
    } else {
      current = false;
    }
    if (outcome === "reject") {
      prepared.reject(reason);
    }
  } finally {
    prepared.resolve();
  }
  await rejected;
  await scope.drain();
  await entries.waitForPendingEntries();
  expect(startTurn).not.toHaveBeenCalled();
  expect(scope.hasPendingWork).toBe(false);
  if (authorizationAbort) {
    expect(releaseMutation).toHaveBeenCalledOnce();
    expect(releaseAccess).toHaveBeenCalledOnce();
    expect(envelope).not.toHaveBeenCalled();
    expect(waitForTurn).not.toHaveBeenCalled();
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
  await expect(createFacade().wait({ runId: "completed-run", timeoutMs: 0 })).resolves.toEqual(
    result,
  );
});

it.each(["final", "error"])(
  "preserves acceptance ordering and the post-acceptance %s",
  async (completion) => {
    let sourceCurrent = true;
    const assertAdmissionCurrent = vi.fn(() => {
      if (!sourceCurrent) {
        throw new Error("source closed");
      }
    });
    const accepted = createDeferred();
    const { promise: finalGate, resolve: emitFinal } = createDeferred();
    const dispatchError = Object.assign(new Error("turn failed"), { code: "ETURN" });
    startTurn.mockImplementation(async ({ io, assertAdmissionCurrent: admissionGuard }) => {
      expect(admissionGuard).toBe(assertAdmissionCurrent);
      admissionGuard();
      accept(io, "run-1", { runId: "run-1" });
      await finalGate;
      if (completion === "error") {
        throw dispatchError;
      }
      io.emitFinal([true, { runId: "run-1", status: "ok", summary: "done" }, undefined], {
        runId: "run-1",
        terminal: true,
      });
    });
    const onAccepted = vi.fn(() => accepted.resolve());

    const result = requestTurn("run-1", { expectFinal: true, onAccepted, assertAdmissionCurrent });
    await accepted.promise;
    expect(onAccepted).toHaveBeenCalledWith({ runId: "run-1", status: "accepted" });
    sourceCurrent = false;
    const checksAtAcceptance = assertAdmissionCurrent.mock.calls.length;
    emitFinal();

    if (completion === "error") {
      await expect(result).rejects.toBe(dispatchError);
    } else {
      await expect(result).resolves.toEqual({
        ok: true,
        payload: { runId: "run-1", status: "ok", summary: "done" },
        error: undefined,
        meta: { runId: "run-1", terminal: true },
      });
    }
    expect(assertAdmissionCurrent).toHaveBeenCalledTimes(checksAtAcceptance);
  },
);

it.each([
  { cached: false, executing: true },
  { cached: true, executing: false },
  { cached: true, executing: true },
])(
  "reports actual execution (cached=$cached, executing=$executing)",
  async ({ cached, executing }) => {
    const context = createContext();
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
        expect(io.emitExecutionStarted).toBe(onExecutionStarted);
        accept(io, "run-2");
        io.emitExecutionStarted?.();
      }
    });
    const result = await requestTurn("run-2", { onExecutionStarted }, createFacade(context));
    if (cached) {
      expect(result).toEqual({ ok: true, payload, error: undefined, meta });
    } else {
      expect(result).toMatchObject({ ok: true });
    }
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
  "request mutated",
] as const)("keeps startup ownership bound to its registration through %s", async (change) => {
  let gatewayCurrent = true;
  const { request, register, registration, onStartOwner, owner } = await startOwnerFixture(() => {
    if (!gatewayCurrent) {
      throw new Error("gateway closed");
    }
  });
  const observation = owner.observe();
  expect(observation).toEqual({ executionStarted: false });
  expect(() => Reflect.get(observation ?? {}, "expiresAtMs")).toThrowError(
    expect.objectContaining({
      code: "PLUGIN_CAPABILITY_REMOVED",
      capability: "startOwner.observe().expiresAtMs",
      message: expect.stringContaining("startDeadlineAtMs"),
    }),
  );
  let replacement: ReturnType<typeof register> | undefined;
  switch (change) {
    case "aborted":
      registration.controller.abort();
      break;
    case "replaced":
      registration.cleanup();
      replacement = register();
      break;
    case "rotated":
      rotateAgentEventLifecycleGeneration();
      break;
    case "agent changed":
      setTestRpcSourceIdentity(registration.entry, { agentId: "other-agent" });
      break;
    case "session changed":
      setTestRpcSourceIdentity(registration.entry, { sessionId: "replacement-session" });
      break;
    case "gateway closed":
      gatewayCurrent = false;
      break;
    case "request mutated":
      request.agentId = "other-agent";
      request.idempotencyKey = "other-run";
      request.sessionKey = "agent:other:other";
      request.expectedExistingSessionId = "other-session";
      break;
  }
  if (change === "request mutated") {
    expect(owner.observe()).toBeDefined();
    expect(owner.abort()).toBe(true);
    expect(registration.controller.signal.aborted).toBe(true);
  } else {
    expect(owner.observe()).toBeUndefined();
    expect(owner.abort()).toBe(false);
  }
  expect(replacement?.controller.signal.aborted ?? false).toBe(false);
  expect(onStartOwner).toHaveBeenCalledOnce();
  replacement?.cleanup();
  registration.cleanup();
});

it("observes a started owner without reentering its watchdog authority", async () => {
  const { owner, registration } = await startOwnerFixture();
  expect(owner.observe()).toMatchObject({ executionStarted: false });
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
  expect(assertCurrent).toHaveBeenCalledOnce();
  policyCurrent = false;
  expect(attempt.isCurrent()).toBe(false);
  expect(assertCurrent).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "cancels only its accepted run across the dispatch deadline (late acceptance: %s)",
  async (lateAcceptance) => {
    vi.useFakeTimers();
    const context = createContext();
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
        await new Promise<void>((_resolve, reject) => {
          registration.controller.signal.addEventListener(
            "abort",
            () => reject(new Error("deadline run aborted")),
            { once: true },
          );
        });
      }
    });

    try {
      const result = createFacade(context).dispatchRaw(
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
