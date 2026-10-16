// Tests ACP dispatch abort behavior and emitted lifecycle hooks.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, raceWithTimeoutResult } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import type { AcpRuntimeEvent } from "../../plugin-sdk/acp-runtime.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  createDispatcher,
  diagnosticMocks,
  hookMocks,
  internalHookMocks,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  createAcpRuntime,
  createDispatchGate,
  createMockAcpSessionManager,
  resetDispatchSessionMocks,
} from "./dispatch-from-config.test-support.js";
import { expectedNoQueuedReplyResult } from "./dispatch-result-expectations.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let dispatchLowLevelChannelReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchLowLevelChannelReplyFromConfig;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acpx.js").tryDispatchAcpReplyHook;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let replyRunRegistry: typeof import("./reply-run-registry.js").replyRunRegistry;
let getActiveReplyRunCount: typeof import("./reply-run-registry.registry.js").getActiveReplyRunCount;
let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
let replyRunTesting: typeof import("./reply-run-registry.test-support.js").testing;

type ReplyHookContext = {
  abortSignal?: AbortSignal;
  dispatcher: Pick<
    ReturnType<typeof createDispatcher>,
    "sendToolResult" | "sendBlockReply" | "sendFinalReply" | "getQueuedCounts"
  >;
};

function shouldUseAcpReplyDispatchHook(eventUnknown: unknown): boolean {
  const event = eventUnknown as {
    sessionKey?: string;
    isTailDispatch?: boolean;
    ctx?: {
      SessionKey?: string;
      CommandTargetSessionKey?: string;
      AcpDispatchTailAfterReset?: boolean;
    };
  };
  if (event.isTailDispatch === true) {
    return true;
  }
  return [event.sessionKey, event.ctx?.SessionKey, event.ctx?.CommandTargetSessionKey].some(
    (value) => {
      const key = value?.trim();
      return Boolean(key && (key.includes("acp:") || key.includes(":acp") || key.includes("-acp")));
    },
  );
}

function createDiscordCtx(SessionKey: string, BodyForAgent: string) {
  return buildTestCtx({ Provider: "discord", Surface: "discord", SessionKey, BodyForAgent });
}

function createAcpDispatchConfig(diagnostics = false): OpenClawConfig {
  return {
    acp: { enabled: true, dispatch: { enabled: true } },
    session: { sendPolicy: { default: "allow" } },
    ...(diagnostics ? { diagnostics: { enabled: true } } : {}),
  };
}

function createDispatchConfig(diagnostics = true): OpenClawConfig {
  return { diagnostics: { enabled: diagnostics }, session: { sendPolicy: { default: "allow" } } };
}

function createOperation(sessionKey: string, sessionId: string) {
  return createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
}

function acpEntry(
  sessionKey: string,
  agent: string,
  runtimeSessionName: string,
  entry: Record<string, unknown> = {},
) {
  return {
    sessionKey,
    storeSessionKey: sessionKey,
    cfg: {},
    storePath: "/tmp/mock-sessions.json",
    entry,
    acp: {
      backend: "acpx",
      agent,
      runtimeSessionName,
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: Date.now(),
    },
  };
}

function dispatchReply(
  ctx: Parameters<typeof dispatchReplyFromConfig>[0]["ctx"],
  dispatcher: Parameters<typeof dispatchReplyFromConfig>[0]["dispatcher"],
  overrides: Partial<Parameters<typeof dispatchReplyFromConfig>[0]> = {},
) {
  return dispatchReplyFromConfig({ ctx, dispatcher, cfg: createDispatchConfig(), ...overrides });
}

function expectNoReplies(dispatcher: ReturnType<typeof createDispatcher>) {
  expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
}

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

describe("dispatchReplyFromConfig ACP abort", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig, dispatchLowLevelChannelReplyFromConfig } =
      await import("./dispatch-from-config.js"));
    ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acpx.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    ({ replyRunRegistry, createReplyOperation } = await import("./reply-run-registry.js"));
    ({ getActiveReplyRunCount } = await import("./reply-run-registry.registry.js"));
    ({ testing: replyRunTesting } = await import("./reply-run-registry.test-support.js"));
  });

  beforeEach(() => {
    setDiscordTestRegistry();
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
    resetDispatchSessionMocks();
    acpManagerRuntimeMocks.getAcpSessionManager
      .mockReset()
      .mockReturnValue(
        createMockAcpSessionManager({ staleAgentSessions: false, closeOneshot: false }),
      );
    hookMocks.runner.hasHooks
      .mockReset()
      .mockImplementation((hookName?: string) => hookName === "reply_dispatch");
    hookMocks.runner.runBeforeDispatch.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch
      .mockReset()
      .mockImplementation(async (event: unknown, ctx: unknown) => {
        if (!shouldUseAcpReplyDispatchHook(event)) {
          return undefined;
        }
        return (await tryDispatchAcpReplyHook(event as never, ctx as never)) ?? undefined;
      });
    hookMocks.runner.runInboundClaim.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome
      .mockReset()
      .mockResolvedValue({ status: "no_handler" });
    hookMocks.runner.runMessageReceived.mockReset();
    internalHookMocks.createInternalHookEvent
      .mockReset()
      .mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset();
    sessionStoreMocks.loadSessionEntry
      .mockReset()
      .mockImplementation(() => sessionStoreMocks.currentEntry);
    acpMocks.getAcpRuntimeBackend.mockReset();
    resetPluginTtsAndThreadMocks();
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    agentEventMocks.onAgentEvent.mockReset().mockImplementation(() => () => {});
    setNoAbort();
  });

  it("aborts ACP dispatch promptly when the caller abort signal fires", async () => {
    const turnStarted = createDeferred();
    const releaseTurn = createDeferred();
    const runtime = createAcpRuntime([]);
    runtime.runTurn.mockImplementation(async function* (params) {
      turnStarted.resolve();
      await new Promise<void>((resolve) => {
        if (params.signal?.aborted) {
          resolve();
          return;
        }
        const onAbort = () => resolve();
        params.signal?.addEventListener("abort", onAbort, { once: true });
        void releaseTurn.promise.then(() => {
          params.signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      // Cancellation is prompt even while the runtime's final cleanup remains pending.
      await releaseTurn.promise;
      yield { type: "done" } as AcpRuntimeEvent;
    });
    acpMocks.readAcpSessionEntry.mockReturnValue(
      acpEntry("agent:codex-acp:session-1", "codex", "runtime:1"),
    );
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });

    const abortController = new AbortController();
    const dispatcher = createDispatcher();
    const ctx = createDiscordCtx("agent:codex-acp:session-1", "write a test");
    const dispatchPromise = dispatchReply(ctx, dispatcher, {
      cfg: createAcpDispatchConfig(),
      replyOptions: { abortSignal: abortController.signal },
    });

    let operation: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await Promise.race([
        turnStarted.promise,
        dispatchPromise.then(() => {
          throw new Error("ACP dispatch completed before its runtime turn started");
        }),
      ]);
      expect(runtime.runTurn).toHaveBeenCalledTimes(1);
      operation = replyRunRegistry.get("agent:codex-acp:session-1");
      expect(operation?.ownerSettlement).toBeDefined();
      abortController.abort();
      await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
      expect(replyRunRegistry.get("agent:codex-acp:session-1")).toBe(operation);
      expect(operation?.abortSignal.aborted).toBe(true);
      expect(runtime.runTurn.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expectNoReplies(dispatcher);

      releaseTurn.resolve();
      await operation?.ownerSettlement;
      expectNoReplies(dispatcher);
      expect(getActiveReplyRunCount()).toBe(0);
    } finally {
      releaseTurn.resolve();
      await Promise.allSettled([dispatchPromise, operation?.ownerSettlement]);
    }
  });

  it("completes the dispatch-owned operation when ACP tail dispatch handles the turn", async () => {
    hookMocks.runner.runReplyDispatch.mockImplementation(async (eventUnknown: unknown) => {
      const event = eventUnknown as { isTailDispatch?: boolean };
      if (event.isTailDispatch === true) {
        return { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      }
      return undefined;
    });

    const dispatcher = createDispatcher();
    const ctx = createDiscordCtx("agent:main:regular-tail", "/reset continue");
    const result = await dispatchReply(ctx, dispatcher, {
      cfg: createAcpDispatchConfig(true),
      replyResolver: async (resolverCtx) => {
        resolverCtx.AcpDispatchTailAfterReset = true;
        return undefined;
      },
    });

    expect(result.counts.final).toBe(0);
    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledTimes(2);
    expect(getActiveReplyRunCount()).toBe(0);
  });

  it.each([false, true])(
    "suppresses late reply_dispatch sends after source abort (existing operation=%s)",
    async (existing) => {
      const sessionKey = "agent:main:reply-dispatch-abort";
      const hook = createDispatchGate();
      const hookCompleted = createDeferred();
      const lateSendResults: boolean[] = [];
      const abortStates: boolean[] = [];
      let hookAbortSignal: AbortSignal | undefined;
      hookMocks.runner.runReplyDispatch.mockImplementation(
        async (_event: unknown, context: unknown) => {
          const { dispatcher, abortSignal } = context as ReplyHookContext;
          hookAbortSignal = abortSignal;
          await hook.wait();
          abortStates.push(abortSignal?.aborted === true);
          lateSendResults.push(
            dispatcher.sendToolResult({ text: "late tool should not send" }),
            dispatcher.sendBlockReply({ text: "late block should not send" }),
            dispatcher.sendFinalReply({ text: "late final should not send" }),
          );
          hookCompleted.resolve();
          return { handled: true, queuedFinal: false, counts: dispatcher.getQueuedCounts() };
        },
      );
      let operation = existing ? createOperation(sessionKey, "active-session") : undefined;
      const dispatcher = createDispatcher();
      const dispatchPromise = dispatchReply(
        createDiscordCtx(sessionKey, "hang in reply dispatch"),
        dispatcher,
        { replyResolver: vi.fn() },
      );
      try {
        await hook.started;
        operation ??= replyRunRegistry.get(sessionKey);
        if (existing) {
          expect(hookAbortSignal?.aborted).toBe(false);
        }
        if (!existing) {
          expect(operation?.ownerSettlement).toBeDefined();
        }
        expect(replyRunRegistry.abort(sessionKey)).toBe(true);
        expect(operation?.abortSignal.aborted).toBe(true);
        if (existing) {
          expect(hookAbortSignal?.aborted).toBe(true);
        }
        await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
        if (existing) {
          expect(operation?.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
        } else {
          expect(replyRunRegistry.get(sessionKey)).toBe(operation);
          expectNoReplies(dispatcher);
        }
        hook.resolve();
        await hookCompleted.promise;
        if (!existing) {
          await operation?.ownerSettlement;
        }
        if (existing) {
          expect(abortStates).toEqual([true]);
        }
        expect(lateSendResults).toEqual([false, false, false]);
        expectNoReplies(dispatcher);
        expect(getActiveReplyRunCount()).toBe(0);
      } finally {
        hook.resolve();
        await Promise.allSettled([dispatchPromise, operation?.ownerSettlement]);
      }
    },
  );

  it("keys bound ACP tail abort ownership to the source dispatch session", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C1";
    const boundAcpSessionKey = "agent:codex:acp:bound-session";
    const boundConversation = {
      bindingId: "binding-acp-tail",
      targetSessionKey: boundAcpSessionKey,
      targetKind: "session" as const,
      status: "active" as const,
      boundAt: Date.now(),
      conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
    };
    const sessionStore: Record<string, { sessionId: string; updatedAt: number }> = {
      [sourceSessionKey]: { sessionId: "source-session-id", updatedAt: Date.now() },
      [boundAcpSessionKey]: { sessionId: "acp-session-id", updatedAt: Date.now() },
    };
    sessionBindingMocks.resolveByConversation.mockReturnValue(boundConversation);
    sessionStoreMocks.currentEntry = sessionStore[sourceSessionKey];
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation((...args: unknown[]) => {
      const params = args[0] as { sessionKey?: string };
      const existing = params.sessionKey ? sessionStore[params.sessionKey] : undefined;
      return existing && typeof existing === "object"
        ? (existing as Record<string, unknown>)
        : undefined;
    });
    acpMocks.readAcpSessionEntry.mockImplementation((params: { sessionKey: string }) =>
      params.sessionKey === boundAcpSessionKey
        ? acpEntry(boundAcpSessionKey, "codex", "runtime:bound", sessionStore[boundAcpSessionKey])
        : null,
    );

    const tailDispatchStarted = createDeferred();
    const releaseTailDispatch = createDeferred();
    let tailSessionKey: string | undefined;
    let tailAbortSignal: AbortSignal | undefined;
    hookMocks.runner.runReplyDispatch.mockImplementation(
      async (eventUnknown: unknown, hookCtxUnknown: unknown) => {
        const event = eventUnknown as {
          sessionKey?: string;
          isTailDispatch?: boolean;
        };
        if (event.isTailDispatch === true) {
          const hookCtx = hookCtxUnknown as { abortSignal?: AbortSignal };
          tailSessionKey = event.sessionKey;
          tailAbortSignal = hookCtx.abortSignal;
          tailDispatchStarted.resolve();
          await releaseTailDispatch.promise;
        }
        return undefined;
      },
    );

    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      AccountId: "default",
      To: "C1",
      SessionKey: sourceSessionKey,
      BodyForAgent: "/reset continue",
    });
    const dispatchPromise = dispatchReply(ctx, dispatcher, {
      cfg: createAcpDispatchConfig(true),
      replyResolver: async (resolverCtx) => {
        resolverCtx.AcpDispatchTailAfterReset = true;
        return undefined;
      },
    });

    let operation: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await tailDispatchStarted.promise;
      operation = replyRunRegistry.get(sourceSessionKey);
      expect(operation?.ownerSettlement).toBeDefined();
      expect(tailSessionKey).toBe(boundAcpSessionKey);
      expect(tailAbortSignal).toBeDefined();
      expect(replyRunRegistry.abort(boundAcpSessionKey)).toBe(false);
      expect(replyRunRegistry.abort(sourceSessionKey)).toBe(true);

      await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
      expect(replyRunRegistry.get(sourceSessionKey)).toBe(operation);
      expect(replyRunRegistry.get(boundAcpSessionKey)).toBeUndefined();
      expect(operation?.abortSignal.aborted).toBe(true);
      expect(tailAbortSignal?.aborted).toBe(true);

      releaseTailDispatch.resolve();
      await operation?.ownerSettlement;
      expectNoReplies(dispatcher);
      expect(getActiveReplyRunCount()).toBe(0);
    } finally {
      releaseTailDispatch.resolve();
      await Promise.allSettled([dispatchPromise, operation?.ownerSettlement]);
    }
  });

  it.each([false, true])(
    "keeps pre-dispatch abort ownership on the source (native command=%s)",
    async (native) => {
      hookMocks.runner.hasHooks.mockImplementation((name?: string) => name === "before_dispatch");
      const hook = createDispatchGate();
      hookMocks.runner.runBeforeDispatch.mockImplementation(async () => {
        await hook.wait();
        return undefined;
      });
      const source = native
        ? "agent:main:discord:slash:user-1"
        : "agent:main:diagnostics-disabled-abort";
      const target = "agent:main:discord:channel:target-1";
      const ctx = native
        ? buildTestCtx({
            Provider: "discord",
            Surface: "discord",
            CommandSource: "native",
            CommandTurn: { kind: "native", source: "native", authorized: true },
            SessionKey: source,
            CommandTargetSessionKey: target,
            BodyForAgent: "hang before command source dispatch",
          })
        : createDiscordCtx(source, "hang in before dispatch");
      const dispatcher = createDispatcher();
      const dispatchPromise = dispatchReply(ctx, dispatcher, {
        cfg: createDispatchConfig(native),
        replyResolver: vi.fn(),
      });
      let operation: ReturnType<typeof createReplyOperation> | undefined;
      try {
        if (native) {
          await expect(
            raceWithTimeoutResult(
              hook.started.then(() => "started" as const),
              100,
              "pending" as const,
            ),
          ).resolves.toBe("started");
        } else {
          await hook.started;
        }
        operation = replyRunRegistry.get(source);
        expect(operation?.ownerSettlement).toBeDefined();
        if (native) {
          expect(replyRunRegistry.abort(target)).toBe(false);
        }
        expect(replyRunRegistry.abort(source)).toBe(true);
        await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
        expect(replyRunRegistry.get(source)).toBe(operation);
        if (native) {
          expect(replyRunRegistry.get(target)).toBeUndefined();
        }
        expect(operation?.abortSignal.aborted).toBe(true);
        if (!native) {
          expect(diagnosticMocks.logMessageProcessed).not.toHaveBeenCalled();
        }
        hook.resolve();
        await operation?.ownerSettlement;
        expectNoReplies(dispatcher);
        expect(getActiveReplyRunCount()).toBe(0);
      } finally {
        hook.resolve();
        await Promise.allSettled([dispatchPromise, operation?.ownerSettlement]);
      }
    },
  );

  it("suppresses handled before_dispatch final delivery after active source abort", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "before_dispatch",
    );
    mocks.routeReply.mockClear();
    const existingOperation = createOperation(
      "agent:main:already-active-handled",
      "already-active-session",
    );
    hookMocks.runner.runBeforeDispatch.mockImplementation(async () => {
      expect(replyRunRegistry.abort("agent:main:already-active-handled")).toBe(true);
      return { handled: true, text: "handled by hook" };
    });
    const dispatcher = createDispatcher();
    const ctx = createDiscordCtx(
      "agent:main:already-active-handled",
      "hook handles while an operation is already active",
    );

    const dispatchPromise = dispatchReply(ctx, dispatcher, { replyResolver: vi.fn() });

    await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(existingOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(getActiveReplyRunCount()).toBe(0);
  });

  it.each([false, true])(
    "keeps low-level ACP successor cancellation separate from its predecessor (caller abort=%s)",
    async (cancelCaller) => {
      const sessionKey = "agent:main:acp:successor";
      const turnStarted = createDeferred();
      const releaseTurn = createDeferred();
      const runtime = createAcpRuntime([]);
      runtime.runTurn.mockImplementation(async function* () {
        turnStarted.resolve();
        await releaseTurn.promise;
        yield { type: "text_delta", stream: "output", text: "Successor reply" };
        yield { type: "done", status: "completed" };
      });
      acpMocks.readAcpSessionEntry.mockReturnValue(
        acpEntry(sessionKey, "main", "runtime:successor"),
      );
      acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });
      const predecessor = createOperation(sessionKey, "predecessor-session");
      const caller = new AbortController();
      const dispatcher = createDispatcher();
      const dispatch = dispatchLowLevelChannelReplyFromConfig({
        ctx: createDiscordCtx(sessionKey, "Retry the interrupted task"),
        cfg: createAcpDispatchConfig(),
        dispatcher,
        replyOptions: { abortSignal: caller.signal },
      });

      try {
        await Promise.race([
          turnStarted.promise,
          dispatch.then(() => {
            throw new Error("ACP successor completed before its runtime started");
          }),
        ]);
        expect(predecessor.abortByUser()).toBe(true);
        if (cancelCaller) {
          caller.abort();
        }
        releaseTurn.resolve();
        await dispatch;

        expect(runtime.runTurn).toHaveBeenCalledOnce();
        expect(runtime.runTurn.mock.calls[0]?.[0].signal?.aborted).toBe(cancelCaller);
        if (cancelCaller) {
          expectNoReplies(dispatcher);
        } else {
          expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ text: "Successor reply" }),
          );
        }
      } finally {
        releaseTurn.resolve();
        await Promise.allSettled([dispatch]);
        predecessor.complete();
      }
    },
  );

  it.each([false, true])("suppresses waiting resolver after caller abort=%s", async (caller) => {
    const key = caller
      ? "agent:main:already-active-caller-abort"
      : "agent:main:already-active-resolver";
    const operation = createOperation(key, "active-session");
    if (!caller) {
      operation.setPhase("running");
    }
    const controller = new AbortController();
    const replyResolver = vi.fn(async () =>
      caller ? { text: "late final should not send" } : undefined,
    );
    const dispatcher = createDispatcher();
    const result = dispatchReply(
      createDiscordCtx(
        key,
        caller
          ? "resolver should honor caller abort too"
          : "resolver waits behind active operation",
      ),
      dispatcher,
      {
        replyResolver,
        ...(caller ? { replyOptions: { abortSignal: controller.signal } } : {}),
      },
    );
    if (caller) {
      controller.abort();
    } else {
      expect(replyRunRegistry.abort(key)).toBe(true);
    }
    await expect(result).resolves.toMatchObject(expectedNoQueuedReplyResult());
    expect(operation.result).toEqual(caller ? null : { kind: "aborted", code: "aborted_by_user" });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    if (caller) {
      operation.abortByUser();
    } else {
      operation.complete();
    }
    expect(getActiveReplyRunCount()).toBe(0);
  });

  it.each([
    { abort: "abortByUser", expected: "cancelled" },
    { abort: "abortForRestart", expected: "cancelled" },
    { abort: "supersede", expected: "superseded" },
  ] as const)(
    "records $abort before an abort-insensitive resolver settles",
    async ({ abort, expected }) => {
      const resolverStarted = createDeferred();
      const releaseResolver = createDeferred();
      const resolverFinished = createDeferred();
      const runState: ReplyOperationRunState = {};
      const dispatcher = createDispatcher();
      const ctx = createDiscordCtx("agent:main:resolver-abort", "hang in resolver");
      const dispatchPromise = dispatchReply(ctx, dispatcher, {
        replyOptions: { [REPLY_OPERATION_RUN_STATE]: runState },
        replyResolver: async (_resolverCtx, options) => {
          resolverStarted.resolve();
          await releaseResolver.promise;
          try {
            await options?.onToolResult?.({ text: "late tool should not send" });
            await options?.onBlockReply?.({ text: "late block should not send" });
            const [plan] = createStructuredOutboundPayloadPlan([
              { text: "late prepared block should not send" },
            ]);
            if (!plan || !options?.onPreparedBlockReply) {
              throw new Error("Prepared block callback unavailable");
            }
            await options.onPreparedBlockReply(plan);
            return { text: "late final should not send" };
          } finally {
            resolverFinished.resolve();
          }
        },
      });

      await resolverStarted.promise;
      const operation = replyRunRegistry.get("agent:main:resolver-abort");
      try {
        expect(operation?.[abort]()).toBe(true);
        await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
        expect(runState.agentTurnOwner).toBe(operation);
        expect(resolveReplyOperationAgentTurn(runState)).toBe(expected);
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      } finally {
        releaseResolver.resolve();
        await resolverFinished.promise;
        await replyRunRegistry.waitForIdle("agent:main:resolver-abort");
      }

      expectNoReplies(dispatcher);
      expect(getActiveReplyRunCount()).toBe(0);
    },
  );

  it("treats a resolver AbortError after dispatch abort as a handled dispatch", async () => {
    const { promise: resolverStartedPromise, resolve: resolverStarted } = createDeferred();

    const dispatcher = createDispatcher();
    const ctx = createDiscordCtx("agent:main:resolver-abort-error", "abort in resolver");
    const dispatchPromise = dispatchReply(ctx, dispatcher, {
      replyResolver: async (_resolverCtx, options) => {
        resolverStarted();
        const abortSignal = options?.abortSignal;
        if (!abortSignal) {
          throw new Error("expected dispatch abort signal");
        }
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        const err = new Error("resolver aborted");
        err.name = "AbortError";
        throw err;
      },
    });

    await resolverStartedPromise;
    expect(replyRunRegistry.abort("agent:main:resolver-abort-error")).toBe(true);

    await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "skipped", reason: "reply_operation_aborted" }),
    );
    expect(getActiveReplyRunCount()).toBe(0);
  });

  it("admits unauthorized native /stop on the source while the target has an active run", async () => {
    const sourceSessionKey = "agent:main:telegram:slash:user-unauth";
    const targetSessionKey = "agent:main:telegram:group:target-run";
    const targetOperation = createOperation(targetSessionKey, "target-active-session");
    targetOperation.setPhase("running");

    const replyResolver = vi.fn(async () => ({
      text: "You are not authorized to use this command.",
    }));
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      CommandSource: "native",
      CommandAuthorized: false,
      CommandTurn: {
        kind: "native",
        source: "native",
        authorized: false,
        commandName: "stop",
        body: "/stop",
      },
      SessionKey: sourceSessionKey,
      CommandTargetSessionKey: targetSessionKey,
      Body: "/stop",
      RawBody: "/stop",
      CommandBody: "/stop",
      BodyForAgent: "/stop",
    });

    const dispatchPromise = dispatchReply(ctx, dispatcher, { replyResolver });

    type DispatchOutcome =
      | { status: "settled"; result: Awaited<typeof dispatchPromise> }
      | { status: "pending" };
    const outcome = await raceWithTimeoutResult<DispatchOutcome>(
      dispatchPromise.then((result) => ({ status: "settled" as const, result })),
      200,
      { status: "pending" as const },
    );
    expect(outcome).toMatchObject({ status: "settled", result: { queuedFinal: true } });
    expect(replyResolver).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "You are not authorized to use this command.",
    });
    // Target run must remain active — command admission is source-keyed.
    expect(targetOperation.result).toBeNull();
    expect(replyRunRegistry.get(targetSessionKey)).toBe(targetOperation);
    expect(replyRunRegistry.get(sourceSessionKey)).toBeUndefined();
    targetOperation.complete();
    expect(getActiveReplyRunCount()).toBe(0);
  });

  it("does not let a current-session fast abort abort its own dispatch operation", async () => {
    const dispatcher = createDispatcher();
    const ctx = createDiscordCtx("agent:main:self-stop", "/stop");
    const replyResolver = vi.fn();

    await expect(
      dispatchReply(ctx, dispatcher, {
        replyOptions: { sourceReplyDeliveryMode: "automatic" },
        replyResolver,
        fastAbortResolver: async () => {
          expect(replyRunRegistry.abort("agent:main:self-stop")).toBe(false);
          return { handled: true, aborted: true };
        },
        formatAbortReplyTextResolver: () => "stopped",
      }),
    ).resolves.toMatchObject({ queuedFinal: true });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "stopped" });
    expect(getActiveReplyRunCount()).toBe(0);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
