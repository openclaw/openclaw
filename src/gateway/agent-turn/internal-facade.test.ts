import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { GatewayRequestEntryLifetime } from "../server-request-entry.js";
import { createInternalAgentTurnFacade } from "./internal-facade.js";
import type { AgentTurnStartOwner } from "./internal-facade.types.js";

const startTurn = vi.hoisted(() => vi.fn());
const waitForTurn = vi.hoisted(() => vi.fn());
const runtimeLoad = vi.hoisted(() => ({ loaded: false }));
const authorize = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const envelope = vi.hoisted(() => vi.fn(async (run: () => Promise<unknown>) => await run()));

vi.mock("../server-methods.js", () => ({
  authorizeGatewayRequestPreDispatch: authorize,
  createRequestGatewayMethodRegistry: () => ({
    isControlPlaneWrite: () => false,
  }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await envelope(run),
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
    chatAbortControllers: new Map(),
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
    nodeSendToSession: vi.fn(),
    removeChatRun: vi.fn(() => undefined),
  });
}

function createFacade(context = createContext()) {
  return createInternalAgentTurnFacade({
    client: createSyntheticPluginRuntimeClient(),
    getContext: () => context,
  });
}

describe("createInternalAgentTurnFacade", () => {
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
        const scope = new AsyncWorkScope();
        const entries = new GatewayRequestEntryLifetime();
        const executions: Promise<unknown>[] = [];
        const trackExecution: GatewayRequestContext["trackExecution"] = (run) => {
          const execution = scope.track(run);
          executions.push(execution);
          return execution;
        };
        const context = Object.assign(createContext(), {
          trackExecution,
          requestEntryLifetime: entries,
        });
        let current = true;
        const assertCurrent = () => {
          if (!current) {
            throw new Error("caller retired");
          }
        };
        const facade = createInternalAgentTurnFacade({
          client: createSyntheticPluginRuntimeClient(),
          getContext: () => context,
          ...(boundary === "context" ? { assertContextCurrent: assertCurrent } : {}),
        });
        const controller = new AbortController();
        const request = (
          method === "dispatch"
            ? facade.dispatchRaw(
                { message: "test", idempotencyKey: "cold-run" },
                {
                  signal: controller.signal,
                  ...(boundary === "deadline" ? { timeoutMs: 0, cancelOnDeadline: false } : {}),
                  ...(boundary === "admission" ? { assertAdmissionCurrent: assertCurrent } : {}),
                },
              )
            : facade.wait(
                { runId: "cold-run", timeoutMs: 0 },
                boundary === "deadline" ? 0 : undefined,
                controller.signal,
              )
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let entriesSettled = false;
        let scopeSettled = false;
        let joinedEntries: Promise<void> | undefined;
        let joinedScope: Promise<void> | undefined;
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
          joinedEntries = entries.waitForPendingEntries().then(() => {
            entriesSettled = true;
          });
          joinedScope = scope.drain().then(() => {
            scopeSettled = true;
          });
          await nextTurn();
          expect.soft(entriesSettled, `${method}/${boundary} preparation`).toBe(false);
          expect.soft(scopeSettled, `${method}/${boundary} execution`).toBe(false);
          unblock();
          const outcome = await request;
          await Promise.all([joinedEntries, joinedScope]);
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
          expect(await Promise.allSettled(executions), `${method}/${boundary} execution`).toEqual([
            boundary === "deadline"
              ? {
                  status: "fulfilled",
                  value: method === "dispatch" ? undefined : { status: "timeout" },
                }
              : { status: "rejected", reason: expect.objectContaining({ message }) },
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
          await Promise.allSettled([request, joinedEntries, joinedScope]);
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

  it.each(["dispatch", "wait"] as const)(
    "does not start %s execution when the caller aborts during authorization",
    async (method) => {
      const reached = createDeferred();
      const release = createDeferred();
      authorize.mockImplementationOnce(async () => {
        reached.resolve();
        await release.promise;
        return { error: null };
      });
      const context = createContext();
      const trackExecution = vi.spyOn(context, "trackExecution");
      const entries = new GatewayRequestEntryLifetime();
      const facade = createFacade({ ...context, requestEntryLifetime: entries });
      const controller = new AbortController();
      const reason = new Error("caller canceled during authorization");
      const request =
        method === "dispatch"
          ? facade.dispatchRaw(
              { message: "test", idempotencyKey: "authorization-abort" },
              { signal: controller.signal },
            )
          : facade.wait(
              { runId: "authorization-abort", timeoutMs: 0 },
              undefined,
              controller.signal,
            );
      const rejected = expect(request).rejects.toBe(reason);
      try {
        await reached.promise;
        controller.abort(reason);
      } finally {
        release.resolve();
      }
      await rejected;
      await entries.waitForPendingEntries();
      expect(trackExecution).not.toHaveBeenCalled();
      expect(envelope).not.toHaveBeenCalled();
      expect(startTurn).not.toHaveBeenCalled();
      expect(waitForTurn).not.toHaveBeenCalled();
    },
  );

  it.each(["authorization", "envelope"] as const)(
    "rejects a source closed during %s before starting a turn",
    async (boundary) => {
      let current = true;
      const assertAdmissionCurrent = () => {
        if (!current) {
          throw new Error("source closed");
        }
      };
      if (boundary === "authorization") {
        authorize.mockImplementationOnce(async () => {
          await Promise.resolve();
          current = false;
          return { error: null };
        });
      } else {
        envelope.mockImplementationOnce(async (run) => {
          await Promise.resolve();
          current = false;
          return await run();
        });
      }
      startTurn.mockImplementation(async ({ io }) => {
        io.emitAcceptance([true, { runId: "stale-source", status: "accepted" }, undefined]);
      });

      await expect(
        createFacade().dispatchRaw(
          { message: "test", idempotencyKey: "stale-source" },
          { assertAdmissionCurrent },
        ),
      ).rejects.toThrow("source closed");
      expect(startTurn).not.toHaveBeenCalled();
    },
  );

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

  it("preserves accepted/final ordering and acceptance metadata without frames", async () => {
    let sourceCurrent = true;
    const assertAdmissionCurrent = vi.fn(() => {
      if (!sourceCurrent) {
        throw new Error("source closed");
      }
    });
    const { promise: finalGate, resolve: emitFinal } = createDeferred();
    startTurn.mockImplementation(async ({ io, assertAdmissionCurrent: admissionGuard }) => {
      expect(admissionGuard).toBe(assertAdmissionCurrent);
      admissionGuard();
      io.emitAcceptance([true, { runId: "run-1", status: "accepted" }, undefined], {
        runId: "run-1",
      });
      await finalGate;
      io.emitFinal([true, { runId: "run-1", status: "ok", summary: "done" }, undefined], {
        runId: "run-1",
        terminal: true,
      });
    });
    const onAccepted = vi.fn();

    const result = createFacade().dispatchRaw(
      { message: "test", idempotencyKey: "run-1" },
      { expectFinal: true, onAccepted, assertAdmissionCurrent },
    );
    await vi.waitFor(() =>
      expect(onAccepted).toHaveBeenCalledWith({
        runId: "run-1",
        status: "accepted",
      }),
    );
    sourceCurrent = false;
    const checksAtAcceptance = assertAdmissionCurrent.mock.calls.length;
    emitFinal();

    await expect(result).resolves.toEqual({
      ok: true,
      payload: { runId: "run-1", status: "ok", summary: "done" },
      error: undefined,
      meta: { runId: "run-1", terminal: true },
    });
    expect(assertAdmissionCurrent).toHaveBeenCalledTimes(checksAtAcceptance);
  });

  it("preserves post-acceptance Error identity", async () => {
    let rejectTurn!: (error: Error) => void;
    startTurn.mockImplementation(
      ({ io }) =>
        new Promise<void>((_resolve, reject) => {
          io.emitAcceptance([true, { runId: "run-error", status: "accepted" }, undefined]);
          rejectTurn = reject;
        }),
    );
    const dispatchError = Object.assign(new Error("turn failed"), { code: "ETURN" });
    const result = createFacade().dispatchRaw(
      { message: "test", idempotencyKey: "run-error" },
      { expectFinal: true },
    );
    await vi.waitFor(() => expect(rejectTurn).toBeTypeOf("function"));

    rejectTurn(dispatchError);

    await expect(result).rejects.toBe(dispatchError);
  });

  it("returns a single acceptance with its metadata when no final is requested", async () => {
    startTurn.mockImplementation(async ({ io }) => {
      io.emitAcceptance([true, { runId: "run-2", status: "in_flight" }, undefined], {
        cached: true,
        runId: "run-2",
      });
    });

    await expect(
      createFacade().dispatchRaw({ message: "test", idempotencyKey: "run-2" }),
    ).resolves.toEqual({
      ok: true,
      payload: { runId: "run-2", status: "in_flight" },
      error: undefined,
      meta: { cached: true, runId: "run-2" },
    });
  });

  it("passes the exact internal execution-start observer to the turn", async () => {
    const onExecutionStarted = vi.fn();
    startTurn.mockImplementation(async ({ io }) => {
      expect(io.emitExecutionStarted).toBe(onExecutionStarted);
      io.emitAcceptance([true, { runId: "run-started", status: "accepted" }, undefined]);
      io.emitExecutionStarted?.();
    });

    await expect(
      createFacade().dispatchRaw(
        { message: "test", idempotencyKey: "run-started" },
        { onExecutionStarted },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(onExecutionStarted).toHaveBeenCalledOnce();
  });

  it.each([
    "aborted",
    "replaced",
    "rotated",
    "agent changed",
    "session changed",
    "gateway closed",
    "request mutated",
  ] as const)("keeps startup ownership bound to its registration through %s", async (change) => {
    const context = createContext();
    let gatewayCurrent = true;
    let owner: AgentTurnStartOwner | undefined;
    const onStartOwner = vi.fn((value: AgentTurnStartOwner) => {
      owner = value;
    });
    const request = {
      agentId: "main",
      message: "resume",
      idempotencyKey: "owned-start",
      sessionKey: "agent:main:owned-start",
      expectedExistingSessionId: "owned-session",
    };
    const register = () =>
      registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        agentId: request.agentId,
        runId: request.idempotencyKey,
        sessionId: request.expectedExistingSessionId,
        sessionKey: request.sessionKey,
        kind: "agent",
        timeoutMs: 60_000,
      });
    const registration = register();
    if (!registration.registered) {
      throw new Error("expected startup registration");
    }
    startTurn.mockImplementation(async ({ io }) => {
      io.emitStartOwner?.(request.idempotencyKey, registration.entry);
      io.emitAcceptance([true, { runId: request.idempotencyKey, status: "accepted" }, undefined], {
        runId: request.idempotencyKey,
      });
    });
    const facade = createInternalAgentTurnFacade({
      client: createSyntheticPluginRuntimeClient(),
      getContext: () => context,
      assertContextCurrent: () => {
        if (!gatewayCurrent) {
          throw new Error("gateway closed");
        }
      },
    });
    await facade.dispatch(request, { onStartOwner });
    if (!owner) {
      throw new Error("expected captured startup owner");
    }
    expect(owner.observe()).toEqual({
      executionStarted: false,
      expiresAtMs: registration.entry.expiresAtMs,
    });
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
        registration.entry.agentId = "other-agent";
        break;
      case "session changed":
        registration.entry.sessionId = "replacement-session";
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

  it("cancels only the accepted run when its opted-in dispatch deadline expires", async () => {
    vi.useFakeTimers();
    const context = createContext();
    const unrelated = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: "unrelated-run",
      sessionId: "unrelated-session",
      sessionKey: "agent:main:unrelated",
      timeoutMs: 60_000,
      kind: "agent",
    });
    let accepted: ReturnType<typeof registerChatAbortController> | undefined;
    startTurn.mockImplementation(async ({ io }) => {
      const registration = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: "deadline-run",
        sessionId: "deadline-session",
        sessionKey: "agent:main:deadline",
        timeoutMs: 60_000,
        kind: "agent",
      });
      accepted = registration;
      io.emitAcceptance([true, { runId: "deadline-run", status: "accepted" }, undefined], {
        runId: "deadline-run",
      });
      await new Promise<void>((_resolve, reject) => {
        registration.controller.signal.addEventListener(
          "abort",
          () => reject(new Error("deadline run aborted")),
          { once: true },
        );
      });
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
      await vi.advanceTimersByTimeAsync(20);

      await outcome;
      expect(accepted?.controller.signal.aborted).toBe(true);
      expect(unrelated.controller.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a run accepted after its opted-in dispatch deadline", async () => {
    vi.useFakeTimers();
    const context = createContext();
    const { promise: acceptanceGate, resolve: accept } = createDeferred();
    let accepted: ReturnType<typeof registerChatAbortController> | undefined;
    startTurn.mockImplementation(async ({ io }) => {
      await acceptanceGate;
      accepted = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: "late-run",
        sessionId: "late-session",
        sessionKey: "agent:main:late",
        timeoutMs: 60_000,
        kind: "agent",
      });
      io.emitAcceptance([true, { runId: "late-run", status: "accepted" }, undefined], {
        runId: "late-run",
      });
    });

    try {
      const result = createFacade(context).dispatchRaw(
        {
          message: "settle requester",
          sessionKey: "agent:main:late",
          idempotencyKey: "late-run",
        },
        { cancelOnDeadline: true, expectFinal: true, timeoutMs: 20 },
      );
      const outcome = expect(result).rejects.toThrow("gateway request timeout for agent");
      await vi.advanceTimersByTimeAsync(20);
      await outcome;

      accept();
      await vi.advanceTimersByTimeAsync(0);
      expect(accepted?.controller.signal.aborted).toBe(true);
    } finally {
      accept();
      vi.useRealTimers();
    }
  });
});
