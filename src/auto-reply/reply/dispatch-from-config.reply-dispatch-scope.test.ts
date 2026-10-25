// Tests dispatch-from-config reply dispatch integration and final payload routing.
// Register dispatch mocks before modules that consume them.
// oxfmt-ignore
import {
  acpMocks,
  createDispatcher,
  createHookCtx,
  emptyConfig,
  hookMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import type { PluginHookReplyDispatchContext } from "../../plugins/hook-types.js";
import type { PluginHookReplyDispatchResult } from "../../plugins/hooks.test-fixtures.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  submitSessionControllerTask,
  releaseSessionControllerClaim,
  updateSessionControllerSourcePolicy,
} from "../../sessions/session-controller.mailbox.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import type { ReplyDispatchRun } from "../get-reply-options.types.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  resetDeliverySettlementFixture,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  createReplyOperation,
  createDispatchGate,
  getSessionControllerOperation,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import {
  createDispatchMemorySession,
  dispatchMemorySessionScope,
} from "./dispatch-memory-session.test-support.js";
import type { InternalGetReplyFromConfig } from "./get-reply.types.js";
import { expectCalls } from "./reply-contract.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { requestCurrentSessionStop } from "./reply-run-stop.test-support.js";
import { readReplySourceInput } from "./reply-source-binding.js";
import * as turnAdmission from "./reply-turn-admission.js";
import { buildTestCtx } from "./test-ctx.js";

const handledReply = { handled: true, queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
function discordCtx(SessionKey: string, overrides: Parameters<typeof buildTestCtx>[0] = {}) {
  return buildTestCtx({
    Body: "hello",
    BodyForAgent: "hello",
    SessionKey,
    Provider: "discord",
    Surface: "discord",
    To: "C1",
    AccountId: "default",
    ...overrides,
  });
}

beforeAll(async () => {
  await globalBeforeAll0();
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  ({ runAfterReplyOperationClear } = await import("../../sessions/session-controller.js"));
  const { testing } = await import("../../sessions/session-controller.test-support.js");
  resetSessionControllerForTest = () => testing.resetSessionControllerForTest();
});

describe("dispatchReplyFromConfig reply hook scope", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    setNoAbort();
    const readEntry = (...args: unknown[]) => {
      const { sessionKey } = args[0] as { sessionKey: string };
      return sessionStoreMocks.entriesBySessionKey.get(sessionKey);
    };
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(readEntry);
    sessionStoreMocks.loadSessionEntry.mockImplementation(readEntry);
  });

  it.each([
    ["local command target from ACP source", false, false],
    ["bound ACP reset tail", true, false],
    ["prepared bound ACP reset tail", true, true],
  ] as const)("scopes reply hooks to the prepared %s", async (_name, bound, prepared) => {
    const sourceKey = bound ? "agent:test:discord:channel:C1" : "agent:test:acp:source";
    const targetKey = bound ? "agent:test:acp:bound" : "agent:test:target";
    const runId = "dispatched-run";
    const onAgentRunStart = vi.fn(() => "reply-dispatch");
    const onPreparedAgentRunStart = vi.fn(() => "reply-dispatch");
    const dispatchRun: ReplyDispatchRun = {
      completionSource: "reply-dispatch",
      getResult: () => ({}),
    };
    const preparedStart = { runId, options: dispatchRun, transcriptStart: null };
    const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
      input: { text: "source user turn" },
      target: () => undefined,
    });
    const sourceEntry = { sessionId: "source-session", updatedAt: Date.now() };
    const targetEntry = { sessionId: "target-session", updatedAt: Date.now() };
    sessionStoreMocks.entriesBySessionKey.set(sourceKey, sourceEntry);
    sessionStoreMocks.entriesBySessionKey.set(targetKey, targetEntry);
    if (bound) {
      sessionBindingMocks.resolveByConversation.mockReturnValue({
        bindingId: "bound-dispatch-kind",
        targetSessionKey: targetKey,
        targetKind: "session",
        status: "active",
        boundAt: Date.now(),
        conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
      });
    }
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName, scope) => hookName === "reply_dispatch" && scope?.dispatchKind !== "agent",
    );
    hookMocks.runner.runReplyDispatch.mockImplementation(async (eventValue, contextValue) => {
      expect(eventValue).toMatchObject({ sessionKey: targetKey });
      expect(contextValue).toMatchObject({ dispatchKind: "acp" });
      const event = eventValue as { isTailDispatch?: boolean };
      if (event.isTailDispatch) {
        const context = contextValue as PluginHookReplyDispatchContext;
        expect(
          prepared
            ? context.onPreparedAgentRunStart?.(preparedStart)
            : context.onAgentRunStart?.(runId, undefined, dispatchRun),
        ).toBe("reply-dispatch");
        context.userTurnTranscriptRecorder?.replaceTextBeforePersistence?.("accepted user turn");
      }
      return event.isTailDispatch ? handledReply : undefined;
    });
    const replyResolver = vi.fn<InternalGetReplyFromConfig>(async (ctx, options) => {
      if (bound) {
        ctx.AcpDispatchTailAfterReset = true;
        return undefined;
      }
      expect(options?.onAgentRunStart?.(runId, undefined, dispatchRun)).toBe("reply-dispatch");
      return { text: "local reply" };
    });
    const ctx = discordCtx(
      sourceKey,
      !bound ? { CommandSource: "native", CommandTargetSessionKey: targetKey } : {},
    );
    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
      replyOptions: {
        ...(prepared ? { onPreparedAgentRunStart } : { onAgentRunStart }),
        userTurnTranscriptRecorder,
      },
    });
    expect(result.queuedFinal).toBe(true);
    expect(hookMocks.runner.hasHooks).toHaveBeenCalledWith("reply_dispatch", {
      dispatchKind: bound ? "acp" : "agent",
    });
    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledTimes(bound ? 2 : 0);
    expect(replyResolver).toHaveBeenCalledTimes(1);
    if (prepared) {
      expectCalls([onPreparedAgentRunStart, [[preparedStart]]], [onAgentRunStart, []]);
    } else {
      expectCalls([onAgentRunStart, [[runId, undefined, dispatchRun]]]);
    }
    expect(userTurnTranscriptRecorder.message?.content).toBe(
      bound ? "accepted user turn" : "source user turn",
    );
  });

  it("refuses restricted ACP takeover before invoking reply hooks", async () => {
    const sessionKey = "agent:test:restricted-acp";
    const entry = {
      sessionId: "restricted-acp-session",
      updatedAt: Date.now(),
      acp: { backend: "acpx" },
    };
    sessionStoreMocks.entriesBySessionKey.set(sessionKey, entry);
    sessionStoreMocks.loadSessionStoreEntry.mockReturnValue(entry);
    sessionStoreMocks.loadSessionEntry.mockReturnValue(entry);
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runReplyDispatch.mockResolvedValue(handledReply);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn<InternalGetReplyFromConfig>();
    const guarded = { permissionMode: "guarded" as const, toolOverrides: { webSearch: false } };

    const result = await dispatchReplyFromConfig({
      ctx: discordCtx(sessionKey),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { admittedSessionSettings: guarded },
    });

    expect(hookMocks.runner.runReplyDispatch).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("cannot enforce its permission or tool policy"),
      }),
    );
    expect(result.queuedFinal).toBe(true);
  });
});
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let runAfterReplyOperationClear: typeof import("../../sessions/session-controller.js").runAfterReplyOperationClear;
let resetSessionControllerForTest: typeof import("../../sessions/session-controller.test-support.js").testing.resetSessionControllerForTest;

const REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS = 60_000;
function pendingFinalDelivery(text: string, state: "prepared" | "delivered" = "prepared") {
  return {
    kind: "replayable" as const,
    text,
    createdAt: 1,
    intentId: "intent-1",
    deliveries: [{ id: "delivery-1", state }],
  };
}

function pendingFinalReply(text: string): ReplyPayload {
  return setReplyPayloadMetadata(
    { text },
    {
      pendingFinalDeliveryCompletion: {
        deliveryId: "delivery-1",
        intentId: "intent-1",
        sessionId: "session-1",
        ...dispatchMemorySessionScope,
      },
    },
  );
}

describe("dispatchReplyFromConfig reply_dispatch hook", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    resetDeliverySettlementFixture();
  });

  function dispatch(options: Partial<Parameters<typeof dispatchReplyFromConfig>[0]>) {
    return dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      ...options,
    });
  }

  async function dispatchFinals(replies: ReplyPayload | ReplyPayload[]) {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createDispatcher();
    const result = await dispatch({ dispatcher, replyResolver: async () => replies });
    expect(result.queuedFinal).toBe(true);
    return dispatcher;
  }

  function activeOperation() {
    const operation = getSessionControllerOperation("agent:test:session");
    if (!operation) {
      throw new Error("expected dispatch reply operation");
    }
    return operation;
  }

  function dispatchInMemory(
    memory: Awaited<ReturnType<typeof createDispatchMemorySession>>,
    dispatcher: ReturnType<typeof createReplyDispatcher>,
    replies: ReplyPayload | ReplyPayload[],
    ctx = createHookCtx(),
  ) {
    return memory.run(() =>
      withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatch({
            ctx: { ...ctx, SessionKey: memory.scope.sessionKey },
            dispatcher,
            replyResolver: async () => replies,
          }),
      }),
    );
  }

  const createPendingSession = (pending: ReturnType<typeof pendingFinalDelivery>) =>
    createDispatchMemorySession({
      sessionId: "session-1",
      updatedAt: 1,
      pendingFinalDelivery: pending,
    });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSessionControllerForTest();
    resetInboundDedupe();
    vi.useRealTimers();
    clearAgentHarnesses();
  });

  it("retries a deferred restart event without resolving its retired source", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    // Recovery can defer a queued event after it has selected its mailbox claim.
    vi.spyOn(turnAdmission, "admitReplyTurn").mockResolvedValueOnce({
      status: "skipped",
      reason: "active-run",
    });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn<InternalGetReplyFromConfig>(async (_ctx, options) => {
      const input = readReplySourceInput(options);
      if (!input) {
        throw new Error("Expected the admitted event source");
      }
      updateSessionControllerSourcePolicy(input, { mode: "followup" });
      return { text: "resumed once" };
    });
    const request = {
      ctx: buildTestCtx({
        Provider: "webchat",
        Surface: "webchat",
        SessionKey: "agent:main:restart-event",
        MessageSid: "restart-event",
        InternalTurnSource: "event",
        InputProvenance: { kind: "internal_system" as const, sourceTool: "restart" },
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { internalEventExecution: { onStarted() {}, onTerminal() {} } },
    };
    await expect(dispatchReplyFromConfig(request)).resolves.toMatchObject({ queuedFinal: false });
    expect(replyResolver).not.toHaveBeenCalled();
    await dispatchReplyFromConfig(request);
    await dispatchReplyFromConfig(request);
    expect(replyResolver).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "resumed once" });
  });

  it("preserves the prepared store owner for ACP metadata", async () => {
    const cfg = {
      agents: { ownership: "explicit" as const, entries: { qa: {}, beta: {} } },
    };
    const { resolveSessionStorePathForAcp } = await vi.importActual<
      typeof import("../../acp/runtime/session-meta-store.js")
    >("../../acp/runtime/session-meta-store.js");
    await acpMocks.readAcpSessionMeta.withImplementation(
      (params) => {
        resolveSessionStorePathForAcp({ ...params, cfg: params.cfg ?? cfg });
        return null;
      },
      async () => {
        const result = await dispatch({
          ctx: { ...createHookCtx(), SessionKey: "agent:beta:main", AgentId: "qa" },
          cfg,
          replyResolver: async () => ({ text: "selected owner reply" }),
        });
        expect(result.queuedFinal).toBe(true);
      },
    );
  });

  it("still applies send-policy deny after an unhandled plugin dispatch", async () => {
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: false,
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    } satisfies PluginHookReplyDispatchResult);
    const dispatcher = createDispatcher();

    const result = await dispatch({
      cfg: { ...emptyConfig, session: { sendPolicy: { default: "deny" } } },
      dispatcher,
      replyResolver: async () => ({ text: "model reply" }),
    });

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sendPolicyDenied: true,
      deliberateSilentTerminalReply: true,
    });
  });

  it("keeps admitted session settings owner-private from takeover hooks", async () => {
    const admittedSessionSettings = {
      permissionMode: "guarded" as const,
      toolOverrides: { webSearch: false, mcpToolsDeny: { github: ["delete_issue"] } },
    };
    hookMocks.runner.runReplyDispatch.mockResolvedValue(handledReply);
    const replyResolver = vi.fn(async (_ctx, options) => {
      expect(options?.admittedSessionSettings).toEqual(admittedSessionSettings);
      return { text: "model reply" } satisfies ReplyPayload;
    });

    await dispatch({
      replyOptions: { admittedSessionSettings },
      replyResolver,
    });

    expect(hookMocks.runner.runReplyDispatch).not.toHaveBeenCalled();
    expect(admittedSessionSettings.toolOverrides.mcpToolsDeny.github).toEqual(["delete_issue"]);
    expect(replyResolver).toHaveBeenCalledOnce();
  });

  it("clears pending final delivery when a later queued final succeeds", async () => {
    vi.useFakeTimers();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const memory = await createPendingSession(pendingFinalDelivery("durable reply"));
    const hookStarted = createDeferred();
    const deliver = vi.fn().mockResolvedValue(undefined);
    let hookCalls = 0;
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: (payload) => {
        if (++hookCalls === 1) {
          hookStarted.resolve();
          return new Promise<never>(() => {});
        }
        return payload;
      },
    });
    const result = dispatchInMemory(
      memory,
      dispatcher,
      [{ text: "first" }, pendingFinalReply("durable reply")],
      { ...createHookCtx(), InputProvenance: { kind: "internal_system" } },
    );
    await hookStarted.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "durable reply" }),
      expect.objectContaining({ kind: "final" }),
    );
    expect(memory.read()?.pendingFinalDelivery).toBeUndefined();
  });

  const createNoSendFailure = (retryable = true) =>
    new PlatformMessageNotDispatchedError("offline", { cause: new Error("offline"), retryable });
  const createPartialDelivery = () =>
    Object.assign(new Error("partial delivery", { cause: createNoSendFailure() }), {
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { visibleReplySent: true },
    });

  it.each([
    ["nested partial envelope", new Error("partial", { cause: createPartialDelivery() }), false],
    ["observer-attached delivery evidence", createNoSendFailure(), true],
  ] as const)("reconciles pending final delivery after %s", async (name, error, preserve) => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const pending = pendingFinalDelivery("recoverable final reply");
    const memory = await createPendingSession(pending);
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw error;
      },
      onError: () => {
        if (name.startsWith("observer")) {
          Object.assign(error, { visibleReplySent: true });
        }
      },
    });
    await dispatchInMemory(memory, dispatcher, pendingFinalReply("recoverable final reply"));
    expect(memory.read()?.pendingFinalDelivery).toMatchObject({
      ...pending,
      deliveries: [{ id: "delivery-1", state: preserve ? "prepared" : "unknown" }],
    });
  });

  it.each(["prepared", "delivered"] as const)(
    "clears %s final custody after pre-delivery cancellation",
    async (state) => {
      hookMocks.runner.hasHooks.mockReturnValue(false);
      const memory = await createPendingSession(
        pendingFinalDelivery("policy-suppressed reply", state),
      );
      const deliver = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createReplyDispatcher({
        deliver,
        beforeDeliver: (payload) =>
          state === "delivered" && payload.text === "policy-suppressed reply" ? payload : null,
      });

      const result = await dispatchInMemory(
        memory,
        dispatcher,
        pendingFinalReply("policy-suppressed reply"),
      );
      const receipt = await dispatcher.waitForIdle();
      expect(memory.read()?.pendingFinalDelivery).toBeUndefined();

      expect(result.queuedFinal).toBe(true);
      expect(deliver).not.toHaveBeenCalled();
      expect(receipt?.counts.final).toMatchObject({
        delivered: 0,
        cancelled: 2,
        failedBeforeSend: 0,
      });
      expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
      expect(result.noVisibleReplyFallbackEligible).toBe(true);
    },
  );

  it("delivers a generated final reply before queued follow-up admission", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const deliveryOrder: string[] = [];
    const deliver = vi.fn(async () => {
      deliveryOrder.push("final");
    });
    const dispatcher = createReplyDispatcher({ deliver });
    let queuedOperation: ReturnType<typeof createReplyOperation> | undefined;
    let queuedClaim: Awaited<ReturnType<typeof submitSessionControllerTask>> | undefined;
    const queued = createDeferred();

    try {
      const result = await dispatch({
        dispatcher,
        replyResolver: async () => {
          const operation = activeOperation();
          operation.fail("run_failed", new Error("provider failed"));
          runAfterReplyOperationClear(operation, () => {
            void submitSessionControllerTask(operation.key, {
              target: captureSessionTarget({
                storeScope: "/tmp/mock-sessions.json",
                sessionKey: operation.key,
              }),
              start: (claim) => {
                deliveryOrder.push("followup");
                queuedClaim = claim;
                queuedOperation = createReplyOperation({
                  sessionKey: operation.key,
                  sessionId: "queued-session",
                  resetTriggered: false,
                  mailboxClaim: claim,
                });
                queued.resolve();
              },
            }).catch(queued.reject);
          });
          return { text: "first reply" };
        },
      });

      expect(result.queuedFinal).toBe(true);
      expect(deliver).toHaveBeenCalledExactlyOnceWith({ text: "first reply" }, { kind: "final" });
      await queued.promise;
      expect(queuedOperation).toBeDefined();
      expect(deliveryOrder).toEqual(["final", "followup"]);
      expect(getSessionControllerOperation("agent:test:session")).toBe(queuedOperation);
    } finally {
      dispatcher.markComplete();
      queuedOperation?.complete();
      if (queuedClaim) {
        releaseSessionControllerClaim(queuedClaim);
        await queuedClaim.settlement.promise;
      }
    }
  });

  it("keeps bounded TTS fallback work alive past the default finalization lease", async () => {
    vi.useFakeTimers();
    const tts = createDispatchGate();
    const dispatcher = createDispatcher();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (paramsUnknown: unknown) => {
      await tts.wait();
      return (paramsUnknown as { payload: ReplyPayload }).payload;
    });

    try {
      const dispatchPromise = dispatch({
        dispatcher,
        replyResolver: async () => {
          activeOperation().freezeAbort();
          return { text: "reply with slow TTS" };
        },
      });

      await tts.started;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);

      const active = getSessionControllerOperation("agent:test:session");
      expect(active).toBeDefined();
      expect(active?.result).toBeNull();
      expect(await requestCurrentSessionStop("agent:test:session")).toBe(false);

      tts.resolve();
      await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: true });
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "reply with slow TTS" });
      expect(getSessionControllerOperation("agent:test:session")).toBeUndefined();
    } finally {
      tts.resolve();
      await vi.runOnlyPendingTimersAsync();
    }
  });

  it("dedupes equivalent non-streaming final payload entries for one turn", async () => {
    const replyPayload = {
      text: "repeat once",
      mediaUrls: ["file:///tmp/repeat.png"],
      channelData: { telegram: { parseMode: "MarkdownV2" } },
    } satisfies ReplyPayload;

    const dispatcher = await dispatchFinals([
      replyPayload,
      { ...replyPayload },
      { ...replyPayload, videoAsNote: false },
    ]);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(replyPayload);
  });

  it.each([
    {
      name: "different native locations",
      replies: [
        { location: { latitude: 1, longitude: 2 } },
        { location: { latitude: 3, longitude: 4 } },
      ],
    },
    {
      name: "normal and round videos sharing the same media",
      replies: [
        { mediaUrl: "file:///tmp/reply.mp4" },
        { mediaUrl: "file:///tmp/reply.mp4", videoAsNote: true },
      ],
    },
  ] satisfies Array<{ name: string; replies: ReplyPayload[] }>)(
    "preserves final payloads with $name",
    async ({ replies }) => {
      const dispatcher = await dispatchFinals(replies);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(replies.length);
      for (const [index, reply] of replies.entries()) {
        expect(dispatcher.sendFinalReply).toHaveBeenNthCalledWith(index + 1, reply);
      }
    },
  );
});
