// Tests ACP dispatch abort behavior and emitted lifecycle hooks.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import type { AcpRuntimeEvent } from "../../plugin-sdk/acp-runtime.js";
import {
  captureSessionTarget,
  runSessionMutation,
  interruptSessionControllerEffects,
} from "../../sessions/session-controller.lifecycle.js";
import {
  captureSessionControllerSourceSettlement,
  reserveSessionControllerSource,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { MsgContext } from "../templating.js";
import {
  createDispatchConfig,
  createMockAcpSessionManager,
} from "./dispatch-from-config.acp-abort.test-support.js";
import { registerNativeDispatchAbortCases } from "./dispatch-from-config.native-abort.cases.js";
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
import { createAcpRuntime } from "./dispatch-from-config.test-support.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { expectedNoQueuedReplyResult } from "./dispatch-result-expectations.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { resolveReplyOperationAgentTurn } from "./reply-operation-run-state.test-support.js";
import { requestCurrentSessionStop } from "./reply-run-stop.test-support.js";
import { prepareReplySourceInput } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let dispatchLowLevelChannelReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchLowLevelChannelReplyFromConfig;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acpx.js").tryDispatchAcpReplyHook;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let getSessionControllerOperation: typeof import("../../sessions/session-controller.js").getSessionControllerOperation;
let waitForSessionRunIdle: typeof import("../../sessions/session-controller.js").waitForSessionRunIdle;
let listActiveReplyRunSessionKeys: typeof import("../../sessions/session-controller.queries.js").listActiveReplyRunSessionKeys;
let createReplyOperation: typeof import("../../sessions/session-controller.js").createReplyOperation;
let controllerTesting: typeof import("../../sessions/session-controller.test-support.js").testing;

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

function expectNoReplies(dispatcher: ReturnType<typeof createDispatcher>) {
  expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
}

function dispatchTest(
  sessionKey: string,
  {
    context,
    cfg = createDispatchConfig(),
    ...params
  }: Omit<DispatchFromConfigParams, "ctx" | "cfg"> & {
    cfg?: DispatchFromConfigParams["cfg"];
    context?: Partial<MsgContext>;
  },
) {
  return dispatchReplyFromConfig({
    ...params,
    cfg,
    ctx: buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: sessionKey,
      ...context,
    }),
  });
}

function setRuntimeSession(
  sessionKey: string,
  runtime: ReturnType<typeof createAcpRuntime>,
  agent = "codex",
) {
  acpMocks.readAcpSessionEntry.mockReturnValue({
    sessionKey,
    storeSessionKey: sessionKey,
    cfg: {},
    storePath: "/tmp/mock-sessions.json",
    entry: {},
    acp: {
      backend: "acpx",
      agent,
      runtimeSessionName: "runtime:1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  });
  acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });
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
    ({ getSessionControllerOperation, waitForSessionRunIdle, createReplyOperation } =
      await import("../../sessions/session-controller.js"));
    ({ listActiveReplyRunSessionKeys } =
      await import("../../sessions/session-controller.queries.js"));
    ({ testing: controllerTesting } =
      await import("../../sessions/session-controller.test-support.js"));
  });

  beforeEach(() => {
    setDiscordTestRegistry();
    controllerTesting.resetSessionControllerForTest();
    resetInboundDedupe();
    acpManagerRuntimeMocks.getAcpSessionManager
      .mockReset()
      .mockReturnValue(createMockAcpSessionManager());
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
    hookMocks.runner.runInboundClaimForPluginOutcome.mockReset().mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runMessageReceived.mockReset();
    internalHookMocks.createInternalHookEvent
      .mockReset()
      .mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionEntry
      .mockReset()
      .mockImplementation(() => sessionStoreMocks.currentEntry);
    sessionStoreMocks.loadSessionStoreEntry
      .mockReset()
      .mockImplementation(() => sessionStoreMocks.currentEntry);
    sessionStoreMocks.resolveSessionStorePathCore
      .mockReset()
      .mockReturnValue("/tmp/mock-sessions.json");
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
    acpMocks.getAcpRuntimeBackend.mockReset();
    acpMocks.requireAcpRuntimeBackend.mockReset();
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    resetPluginTtsAndThreadMocks();
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    agentEventMocks.emitAgentEvent.mockReset();
    agentEventMocks.emitAgentAuditEvent.mockReset();
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
    setRuntimeSession("agent:codex-acp:session-1", runtime);

    const abortController = new AbortController();
    const dispatcher = createDispatcher();
    const dispatchPromise = dispatchTest("agent:codex-acp:session-1", {
      context: { BodyForAgent: "write a test" },
      cfg: {
        acp: { enabled: true, dispatch: { enabled: true } },
        session: { sendPolicy: { default: "allow" } },
      },
      dispatcher,
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
      operation = getSessionControllerOperation("agent:codex-acp:session-1");
      expect(operation?.ownerSettlement).toBeDefined();
      abortController.abort();
      await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
      expect(getSessionControllerOperation("agent:codex-acp:session-1")).toBe(operation);
      expect(operation?.abortSignal.aborted).toBe(true);
      expect(runtime.runTurn.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expectNoReplies(dispatcher);

      releaseTurn.resolve();
      await operation?.ownerSettlement;
      expectNoReplies(dispatcher);
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    } finally {
      releaseTurn.resolve();
      await Promise.allSettled([dispatchPromise, operation?.ownerSettlement]);
    }
  });

  it("completes the dispatch-owned operation when ACP tail dispatch handles the turn", async () => {
    hookMocks.runner.runReplyDispatch.mockImplementation(async (eventUnknown: unknown) => {
      const event = eventUnknown as {
        isTailDispatch?: boolean;
      };
      if (event.isTailDispatch === true) {
        return {
          handled: true,
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        };
      }
      return undefined;
    });

    const dispatcher = createDispatcher();
    const result = await dispatchTest("agent:main:regular-tail", {
      context: { BodyForAgent: "/reset continue" },
      cfg: { ...createDispatchConfig(), acp: { enabled: true, dispatch: { enabled: true } } },
      dispatcher,
      replyResolver: async (resolverCtx) => {
        resolverCtx.AcpDispatchTailAfterReset = true;
        return undefined;
      },
    });

    expect(result.counts.final).toBe(0);
    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledTimes(2);
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
  });

  it.each([false, true])(
    "suppresses abort-insensitive hook sends (existing source=%s)",
    async (active) => {
      const sessionKey = "agent:main:reply-dispatch-abort";
      const started = createDeferred(),
        release = createDeferred(),
        returned = createDeferred();
      const lateSendResults: boolean[] = [];
      const abortStates: boolean[] = [];
      let hookSignal: AbortSignal | undefined;
      hookMocks.runner.runReplyDispatch.mockImplementation(
        async (_event: unknown, value: unknown) => {
          const hook = value as {
            abortSignal?: AbortSignal;
            dispatcher: Pick<
              ReturnType<typeof createDispatcher>,
              "sendToolResult" | "sendBlockReply" | "sendFinalReply" | "getQueuedCounts"
            >;
          };
          hookSignal = hook.abortSignal;
          started.resolve();
          await release.promise;
          abortStates.push(hook.abortSignal?.aborted === true);
          lateSendResults.push(
            hook.dispatcher.sendToolResult({ text: "late tool should not send" }),
            hook.dispatcher.sendBlockReply({ text: "late block should not send" }),
            hook.dispatcher.sendFinalReply({ text: "late final should not send" }),
          );
          returned.resolve();
          return { handled: true, queuedFinal: false, counts: hook.dispatcher.getQueuedCounts() };
        },
      );
      const existing = active
        ? createReplyOperation({
            sessionKey,
            sessionId: "already-active-session",
            resetTriggered: false,
          })
        : undefined;
      const dispatcher = createDispatcher();
      const dispatch = dispatchTest(sessionKey, {
        context: { BodyForAgent: "hang in reply dispatch" },
        dispatcher,
        replyResolver: vi.fn(),
        ...(existing ? { replyOptions: { abortSignal: existing.abortSignal } } : {}),
      });
      let operation: ReturnType<typeof createReplyOperation> | undefined;
      try {
        await started.promise;
        operation = getSessionControllerOperation(sessionKey);
        expect(operation?.ownerSettlement).toBeDefined();
        expect(hookSignal?.aborted).toBe(false);
        expect(await requestCurrentSessionStop(sessionKey)).toBe(true);
        expect(hookSignal?.aborted).toBe(true);
        expect(operation?.abortSignal.aborted).toBe(true);
        await expect(dispatch).resolves.toMatchObject(expectedNoQueuedReplyResult());
        expect(getSessionControllerOperation(sessionKey)).toBe(operation);
        if (existing) {
          expect(existing.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
        }
        expectNoReplies(dispatcher);
        release.resolve();
        await returned.promise;
        existing?.complete();
        await operation?.ownerSettlement;
        expect(abortStates).toEqual([true]);
        expect(lateSendResults).toEqual([false, false, false]);
        expectNoReplies(dispatcher);
        expect(listActiveReplyRunSessionKeys()).toEqual([]);
      } finally {
        release.resolve();
        await returned.promise;
        existing?.complete();
        await Promise.allSettled([dispatch, operation?.ownerSettlement]);
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
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "C1",
      },
    };
    const sessionStore: Record<string, { sessionId: string; updatedAt: number }> = {
      [sourceSessionKey]: {
        sessionId: "source-session-id",
        updatedAt: Date.now(),
      },
      [boundAcpSessionKey]: {
        sessionId: "acp-session-id",
        updatedAt: Date.now(),
      },
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
        ? {
            sessionKey: boundAcpSessionKey,
            storeSessionKey: boundAcpSessionKey,
            cfg: {},
            storePath: "/tmp/mock-sessions.json",
            entry: sessionStore[boundAcpSessionKey],
            acp: {
              backend: "acpx",
              agent: "codex",
              runtimeSessionName: "runtime:bound",
              mode: "persistent",
              state: "idle",
              lastActivityAt: Date.now(),
            },
          }
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
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: { ...createDispatchConfig(), acp: { enabled: true, dispatch: { enabled: true } } },
      dispatcher,
      replyResolver: async (resolverCtx) => {
        resolverCtx.AcpDispatchTailAfterReset = true;
        return undefined;
      },
    });

    let operation: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await tailDispatchStarted.promise;
      operation = getSessionControllerOperation(sourceSessionKey);
      expect(operation?.ownerSettlement).toBeDefined();
      expect(tailSessionKey).toBe(boundAcpSessionKey);
      expect(tailAbortSignal).toBeDefined();
      expect(await requestCurrentSessionStop(boundAcpSessionKey)).toBe(false);
      expect(await requestCurrentSessionStop(sourceSessionKey)).toBe(true);

      await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
      expect(getSessionControllerOperation(sourceSessionKey)).toBe(operation);
      expect(getSessionControllerOperation(boundAcpSessionKey)).toBeUndefined();
      expect(operation?.abortSignal.aborted).toBe(true);
      expect(tailAbortSignal?.aborted).toBe(true);

      releaseTailDispatch.resolve();
      await operation?.ownerSettlement;
      expectNoReplies(dispatcher);
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    } finally {
      releaseTailDispatch.resolve();
      await Promise.allSettled([dispatchPromise, operation?.ownerSettlement]);
    }
  });

  it("registers pre-dispatch abort ownership when diagnostics are disabled", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "before_dispatch",
    );
    const beforeDispatchStarted = createDeferred();
    const releaseBeforeDispatch = createDeferred();
    hookMocks.runner.runBeforeDispatch.mockImplementation(async () => {
      beforeDispatchStarted.resolve();
      await releaseBeforeDispatch.promise;
      return undefined;
    });

    const dispatcher = createDispatcher();
    const dispatchPromise = dispatchTest("agent:main:diagnostics-disabled-abort", {
      context: { BodyForAgent: "hang in before dispatch" },
      cfg: createDispatchConfig(false),
      dispatcher,
      replyResolver: vi.fn(),
    });

    let operation: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await beforeDispatchStarted.promise;
      operation = getSessionControllerOperation("agent:main:diagnostics-disabled-abort");
      expect(operation?.ownerSettlement).toBeDefined();
      expect(await requestCurrentSessionStop("agent:main:diagnostics-disabled-abort")).toBe(true);

      await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
      expect(getSessionControllerOperation("agent:main:diagnostics-disabled-abort")).toBe(
        operation,
      );
      expect(operation?.abortSignal.aborted).toBe(true);
      expect(diagnosticMocks.logMessageProcessed).not.toHaveBeenCalled();

      releaseBeforeDispatch.resolve();
      await operation?.ownerSettlement;
      expectNoReplies(dispatcher);
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    } finally {
      releaseBeforeDispatch.resolve();
      await Promise.allSettled([dispatchPromise, operation?.ownerSettlement]);
    }
  });

  it.each(["before_dispatch", "reply_dispatch"] as const)(
    "retains unclaimed %s source custody until abort-insensitive hook return",
    async (hook) => {
      const key = "agent:main:raw-preparation-" + hook;
      const cfg = createDispatchConfig();
      const ctx = buildTestCtx({ Provider: "discord", Surface: "discord", SessionKey: key });
      const origin = new AbortController();
      const predecessor = createReplyOperation({
        sessionKey: key,
        sessionId: "older-" + hook,
        resetTriggered: false,
      });
      const prepared = await prepareReplySourceInput(ctx, cfg, { abortSignal: origin.signal });
      const input = prepared.input;
      if (!input) {
        throw new Error("missing prepared source");
      }
      const receipt = captureSessionControllerSourceSettlement(input);
      const settled = vi.fn();
      void receipt.then(settled);
      const entered = createDeferred();
      const release = createDeferred();
      const returned = createDeferred();
      hookMocks.runner.hasHooks.mockImplementation((name?: string) => name === hook);
      const heldHook = async () => {
        entered.resolve();
        await release.promise;
        returned.resolve();
        return undefined;
      };
      if (hook === "before_dispatch") {
        hookMocks.runner.runBeforeDispatch.mockImplementation(heldHook);
      } else {
        hookMocks.runner.runReplyDispatch.mockImplementation(heldHook);
      }
      const dispatcher = createDispatcher();
      const resolver = vi.fn();
      const dispatch = dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher,
        replyOptions: prepared.options,
        replyResolver: resolver,
      });
      let mutation: Promise<void> | undefined;
      let next: ReturnType<typeof claimSessionControllerTask> | undefined;
      try {
        await entered.promise;
        expect(input.claim).toBeUndefined();
        origin.abort();
        await expect(dispatch).resolves.toMatchObject(expectedNoQueuedReplyResult());
        // The unrelated predecessor did not grant this source its cancellation authority.
        expect(predecessor.result).toBeNull();
        predecessor.complete();
        await predecessor.ownerSettlement;
        expect(settled).not.toHaveBeenCalled();
        const target = captureSessionTarget({
          storeScope: "/tmp/mock-sessions.json",
          sessionKey: key,
        });
        const mutationEntered = createDeferred();
        const mutated = vi.fn();
        mutation = runSessionMutation({
          target,
          prepare: async () => {
            mutationEntered.resolve();
            await interruptSessionControllerEffects({ target });
          },
          run: async () => {
            mutated();
          },
        });
        await mutationEntered.promise;
        const successor = reserveSessionControllerSource(key, {
          target,
          policy: { mode: "followup" },
        });
        const selected = vi.fn();
        next = claimSessionControllerTask(successor, selected);
        expect(mutated).not.toHaveBeenCalled();
        expect(selected).not.toHaveBeenCalled();
        release.resolve();
        await returned.promise;
        await receipt;
        await mutation;
        const claim = await next;
        expect(settled).toHaveBeenCalledOnce();
        expect(mutated).toHaveBeenCalledOnce();
        expect(selected).toHaveBeenCalledOnce();
        releaseSessionControllerClaim(claim);
        await claim.settlement.promise;
        expect(resolver).not.toHaveBeenCalled();
        expectNoReplies(dispatcher);
      } finally {
        release.resolve();
        predecessor.complete();
        await Promise.allSettled([dispatch, returned.promise, receipt, mutation]);
        const claim = await next;
        if (claim) {
          releaseSessionControllerClaim(claim);
          await claim.settlement.promise;
        }
      }
    },
  );

  it("suppresses handled before_dispatch final delivery after active source abort", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "before_dispatch",
    );
    mocks.routeReply.mockClear();
    const existingOperation = createReplyOperation({
      sessionKey: "agent:main:already-active-handled",
      sessionId: "already-active-session",
      resetTriggered: false,
    });
    hookMocks.runner.runBeforeDispatch.mockImplementation(async () => {
      expect(await requestCurrentSessionStop("agent:main:already-active-handled")).toBe(true);
      return {
        handled: true,
        text: "handled by hook",
      };
    });
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:main:already-active-handled",
      BodyForAgent: "hook handles while an operation is already active",
    });

    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: createDispatchConfig(),
      dispatcher,
      replyOptions: { abortSignal: existingOperation.abortSignal },
      replyResolver: vi.fn(),
    });

    await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(existingOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    existingOperation.complete();
    await existingOperation.ownerSettlement;
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
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
      setRuntimeSession(sessionKey, runtime, "main");
      const predecessor = createReplyOperation({
        sessionKey,
        sessionId: "predecessor-session",
        resetTriggered: false,
      });
      predecessor.registerTerminalProducerFence(async () => true);
      hookMocks.runner.hasHooks.mockImplementation(
        (hookName) => hookName === "before_dispatch" || hookName === "reply_dispatch",
      );
      hookMocks.runner.runBeforeDispatch.mockImplementationOnce(async () => {
        // Recovery releases admission only after fencing the old producer's writes.
        // Its raw cleanup and cancellation remain owned by the predecessor.
        expect(await predecessor.retireAdmissionAfterFencing()).toBe(true);
        return undefined;
      });
      const caller = new AbortController();
      const dispatcher = createDispatcher();
      const dispatch = dispatchLowLevelChannelReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          SessionKey: sessionKey,
          BodyForAgent: "Retry the interrupted task",
        }),
        cfg: {
          acp: { enabled: true, dispatch: { enabled: true } },
          session: { sendPolicy: { default: "allow" } },
        },
        dispatcher,
        replyOptions: { abortSignal: caller.signal },
      });

      try {
        await awaitGateBeforeSettlement(
          turnStarted.promise,
          dispatch,
          "ACP successor completed before its runtime started",
        );
        expect(predecessor.admissionRetired).toBe(true);
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
        predecessor.complete();
        await Promise.allSettled([dispatch, predecessor.ownerSettlement]);
      }
    },
  );

  it.each(["source", "caller"] as const)(
    "honors %s abort while waiting for an active source operation",
    async (abortOwner) => {
      const sessionKey = "agent:main:already-active-resolver";
      const existing = createReplyOperation({
        sessionKey,
        sessionId: "active-session",
        resetTriggered: false,
      });
      if (abortOwner === "source") {
        existing.setPhase("running");
      }
      const caller = new AbortController();
      const replyResolver = vi.fn(async () => ({ text: "late final should not send" }));
      const dispatcher = createDispatcher();
      const dispatch = dispatchTest(sessionKey, {
        context: { BodyForAgent: "resolver waits behind active operation" },
        dispatcher,
        replyResolver,
        replyOptions: {
          abortSignal: abortOwner === "source" ? existing.abortSignal : caller.signal,
        },
      });
      if (abortOwner === "source") {
        expect(await requestCurrentSessionStop(sessionKey)).toBe(true);
      } else {
        caller.abort();
      }
      await expect(dispatch).resolves.toMatchObject(expectedNoQueuedReplyResult());
      expect(existing.result).toEqual(
        abortOwner === "source" ? { kind: "aborted", code: "aborted_by_user" } : null,
      );
      expect(replyResolver).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      if (abortOwner === "caller") {
        existing.abortByUser();
      }
      existing.complete();
      await existing.ownerSettlement;
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    },
  );

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
      const dispatchPromise = dispatchTest("agent:main:resolver-abort", {
        context: { BodyForAgent: "hang in resolver" },
        dispatcher,
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
      const operation = getSessionControllerOperation("agent:main:resolver-abort");
      try {
        expect(operation?.[abort]()).toBe(true);
        if (abort === "supersede") {
          expect(operation?.result).toMatchObject({
            kind: "aborted",
            code: "aborted_for_supersession",
          });
        }
        await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
        expect(runState.agentTurnOwner).toBe(operation);
        expect(resolveReplyOperationAgentTurn(runState)).toBe(expected);
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      } finally {
        releaseResolver.resolve();
        await resolverFinished.promise;
        await waitForSessionRunIdle("agent:main:resolver-abort");
      }

      expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
    },
  );

  it("treats a resolver AbortError after dispatch abort as a handled dispatch", async () => {
    const { promise: resolverStartedPromise, resolve: resolverStarted } = createDeferred();

    const dispatcher = createDispatcher();
    const dispatchPromise = dispatchTest("agent:main:resolver-abort-error", {
      context: { BodyForAgent: "abort in resolver" },
      dispatcher,
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
    expect(await requestCurrentSessionStop("agent:main:resolver-abort-error")).toBe(true);

    await expect(dispatchPromise).resolves.toMatchObject(expectedNoQueuedReplyResult());
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "skipped",
        reason: "reply_operation_aborted",
      }),
    );
    expect(listActiveReplyRunSessionKeys()).toEqual([]);
  });

  registerNativeDispatchAbortCases(() => ({
    dispatchReplyFromConfig,
    getSessionControllerOperation,
    createReplyOperation,
    listActiveReplyRunSessionKeys,
    createDispatchConfig,
    expectNoReplies,
  }));
});
