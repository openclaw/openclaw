// Register dispatch mocks before modules that consume them.
// oxfmt-ignore
import {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  createDispatcher,
  createHookCtx,
  diagnosticMocks,
  emptyConfig,
  hookMocks,
  internalHookMocks,
  mocks,
  resetPluginTtsAndThreadMocks,
  runtimePluginMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import type { PluginHookReplyDispatchResult } from "../../plugins/hooks.test-fixtures.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  createMockAcpSessionManager,
  createDispatchGate,
  resetDispatchSessionMocks,
} from "./dispatch-from-config.test-support.js";
import {
  createDispatchMemorySession,
  dispatchMemorySessionScope,
} from "./dispatch-memory-session.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
let getActiveReplyRunCount: typeof import("./reply-run-registry.registry.js").getActiveReplyRunCount;
let replyRunRegistry: typeof import("./reply-run-registry.js").replyRunRegistry;
let runAfterReplyOperationClear: typeof import("./reply-run-registry.js").runAfterReplyOperationClear;
let resetReplyRunRegistry: typeof import("./reply-run-registry.test-support.js").testing.resetReplyRunRegistry;

const hooks = hookMocks.runner;
const dispatchSessionKey = "agent:test:session";
const REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS = 60_000;
type DispatchInput = Parameters<typeof dispatchReplyFromConfig>[0];
type PendingMemory = Awaited<ReturnType<typeof createDispatchMemorySession>>;

function dispatch(
  dispatcher: DispatchInput["dispatcher"],
  replyResolver: DispatchInput["replyResolver"],
  overrides: Omit<Partial<DispatchInput>, "dispatcher" | "replyResolver"> = {},
) {
  const params = { ctx: createHookCtx(), cfg: emptyConfig, ...overrides };
  return dispatchReplyFromConfig({ ...params, dispatcher, replyResolver });
}

function createPendingMemory(pending: ReturnType<typeof pendingFinal>) {
  return createDispatchMemorySession({
    sessionId: "session-1",
    updatedAt: 1,
    pendingFinalDelivery: pending,
  });
}

function dispatchMemoryReply(
  memory: PendingMemory,
  dispatcher: DispatchInput["dispatcher"],
  reply: ReplyPayload | ReplyPayload[],
  internal = false,
) {
  return memory.run(() =>
    withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatch(dispatcher, async () => reply, {
          ctx: {
            ...createHookCtx(),
            ...(internal ? { InputProvenance: { kind: "internal_system" as const } } : {}),
            SessionKey: memory.scope.sessionKey,
          },
        }),
    }),
  );
}

function pendingFinal(
  text: string,
  overrides: Partial<NonNullable<SessionEntry["pendingFinalDelivery"]>> = {},
) {
  return {
    kind: "replayable" as const,
    text,
    createdAt: 1,
    intentId: "intent-1",
    deliveries: [{ id: "delivery-1", state: "prepared" as const }],
    ...overrides,
  };
}

function finalReply(
  text: string,
  overrides: { deliveryId?: string; intentId?: string } = {},
): ReplyPayload {
  return setReplyPayloadMetadata(
    { text },
    {
      pendingFinalDeliveryCompletion: {
        deliveryId: overrides.deliveryId ?? "delivery-1",
        intentId: overrides.intentId ?? "intent-1",
        sessionId: "session-1",
        ...dispatchMemorySessionScope,
      },
    },
  );
}

describe("dispatchReplyFromConfig reply_dispatch hook", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    ({ createReplyOperation, replyRunRegistry, runAfterReplyOperationClear } =
      await import("./reply-run-registry.js"));
    ({ getActiveReplyRunCount } = await import("./reply-run-registry.registry.js"));
    const { testing } = await import("./reply-run-registry.test-support.js");
    resetReplyRunRegistry = () => testing.resetReplyRunRegistry();
  });

  beforeEach(() => {
    clearAgentHarnesses();
    resetReplyRunRegistry();
    setDiscordTestRegistry();
    resetInboundDedupe();
    resetDispatchSessionMocks();
    mocks.routeReply
      .mockReset()
      .mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset().mockResolvedValue({ handled: false, aborted: false });
    hooks.hasHooks
      .mockReset()
      .mockImplementation((hookName?: string) => hookName === "reply_dispatch");
    hooks.runInboundClaim.mockReset().mockResolvedValue(undefined);
    hooks.runInboundClaimForPlugin.mockReset().mockResolvedValue(undefined);
    hooks.runInboundClaimForPluginOutcome.mockReset().mockResolvedValue({ status: "no_handler" });
    hooks.runMessageReceived.mockReset().mockResolvedValue(undefined);
    hooks.runBeforeDispatch.mockReset().mockResolvedValue(undefined);
    hooks.runReplyDispatch.mockReset().mockResolvedValue(undefined);
    internalHookMocks.createInternalHookEvent
      .mockReset()
      .mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset().mockResolvedValue(undefined);
    sessionStoreMocks.updateSessionEntry.mockClear();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset().mockImplementation(() => ({
      ...createMockAcpSessionManager(),
      resolveSessionAsync: async () => ({ kind: "none" as const }),
      runTurn: vi.fn(),
    }));
    agentEventMocks.onAgentEvent.mockReset().mockImplementation(() => () => {});
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    runtimePluginMocks.loadAgentRuntimePluginRegistryHandle
      .mockReset()
      .mockReturnValue(runtimePluginMocks.pluginRegistry);
    resetPluginTtsAndThreadMocks();
  });

  afterEach(() => {
    resetReplyRunRegistry();
    resetInboundDedupe();
    vi.useRealTimers();
    clearAgentHarnesses();
  });

  it.each(["agent:beta:main"])(
    "preserves the prepared store owner for ACP metadata in %s",
    async (sessionKey) => {
      const cfg = { agents: { ownership: "explicit" as const, entries: { qa: {}, beta: {} } } };
      const { resolveSessionStorePathForAcp } = await vi.importActual<
        typeof import("../../acp/runtime/session-meta-store.js")
      >("../../acp/runtime/session-meta-store.js");
      await acpMocks.readAcpSessionMeta.withImplementation(
        (params) => {
          resolveSessionStorePathForAcp({ ...params, cfg: params.cfg ?? cfg });
          return null;
        },
        async () => {
          const result = await dispatch(
            createDispatcher(),
            async () => ({ text: "selected owner reply" }),
            { ctx: { ...createHookCtx(), SessionKey: sessionKey, AgentId: "qa" }, cfg },
          );
          expect(result.queuedFinal).toBe(true);
        },
      );
    },
  );

  it("still applies send-policy deny after an unhandled plugin dispatch", async () => {
    hooks.runReplyDispatch.mockResolvedValue({
      handled: false,
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    } satisfies PluginHookReplyDispatchResult);
    const dispatcher = createDispatcher();

    const result = await dispatch(dispatcher, async () => ({ text: "model reply" }), {
      cfg: { ...emptyConfig, session: { sendPolicy: { default: "deny" } } },
    });

    expect(hooks.runReplyDispatch).toHaveBeenCalled();
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
    hooks.runReplyDispatch.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    const replyResolver = vi.fn(async (_ctx, options) => {
      expect(options?.admittedSessionSettings).toEqual(admittedSessionSettings);
      return { text: "model reply" } satisfies ReplyPayload;
    });

    await dispatch(createDispatcher(), replyResolver, {
      replyOptions: { admittedSessionSettings },
    });

    expect(hooks.runReplyDispatch).not.toHaveBeenCalled();
    expect(admittedSessionSettings.toolOverrides.mcpToolsDeny.github).toEqual(["delete_issue"]);
    expect(replyResolver).toHaveBeenCalledOnce();
  });

  async function dispatchPastStalledHook(params: {
    pending: ReturnType<typeof pendingFinal>;
    replies: ReplyPayload[];
    stalledIndex: number;
    afterStall?: (memory: PendingMemory) => Promise<void>;
  }) {
    vi.useFakeTimers();
    hooks.hasHooks.mockReturnValue(false);
    const memory = await createPendingMemory(params.pending);
    const hookStarted = createDeferred();
    const deliver = vi.fn().mockResolvedValue(undefined);
    let hookCalls = 0;
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: (payload) => {
        if (++hookCalls === params.stalledIndex) {
          hookStarted.resolve();
          return new Promise<never>(() => {});
        }
        return payload;
      },
    });
    try {
      const result = dispatchMemoryReply(memory, dispatcher, params.replies, true);
      await hookStarted.promise;
      await params.afterStall?.(memory);
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
      return { deliver, entry: memory.read() };
    } finally {
      vi.useRealTimers();
    }
  }

  it("clears pending final delivery when a later queued final succeeds", async () => {
    const { deliver, entry } = await dispatchPastStalledHook({
      pending: pendingFinal("durable reply"),
      replies: [{ text: "first" }, finalReply("durable reply")],
      stalledIndex: 1,
    });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "durable reply" }),
      expect.objectContaining({ kind: "final" }),
    );
    expect(entry?.pendingFinalDelivery).toBeUndefined();
  });

  it("records each pending-final delivery without rewriting aggregate text", async () => {
    const { entry } = await dispatchPastStalledHook({
      pending: pendingFinal("auxiliary\n\ndurable reply", {
        deliveries: [
          { id: "delivery-auxiliary", state: "prepared" },
          { id: "delivery-durable", state: "prepared" },
        ],
      }),
      replies: [
        finalReply("auxiliary", { deliveryId: "delivery-auxiliary" }),
        finalReply("durable reply", { deliveryId: "delivery-durable" }),
      ],
      stalledIndex: 2,
    });
    expect(entry?.pendingFinalDelivery).toEqual(
      pendingFinal("auxiliary\n\ndurable reply", {
        deliveries: [
          { id: "delivery-auxiliary", state: "delivered" },
          { id: "delivery-durable", state: "prepared" },
        ],
      }),
    );
  });

  it("does not let an older settlement rewrite a newer pending-final intent", async () => {
    const newer = pendingFinal("newer reply", { createdAt: 2, intentId: "newer-intent" });
    const { entry } = await dispatchPastStalledHook({
      pending: pendingFinal("older reply", { intentId: "older-intent" }),
      replies: [finalReply("older reply", { intentId: "older-intent" })],
      stalledIndex: 1,
      afterStall: async (memory) => {
        await memory.patch({ pendingFinalDelivery: newer });
      },
    });
    expect(entry?.pendingFinalDelivery).toEqual(newer);
  });

  const createNoSendFailure = () =>
    new PlatformMessageNotDispatchedError("offline", {
      cause: new Error("offline"),
      retryable: true,
    });
  const createPartialDelivery = () =>
    Object.assign(new Error("partial delivery", { cause: createNoSendFailure() }), {
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { visibleReplySent: true },
    });

  it.each([
    ["nested partial envelope", new Error("partial", { cause: createPartialDelivery() }), false],
    ["observer-attached delivery evidence", createNoSendFailure(), true],
  ] as const)("reconciles pending final delivery after %s", async (name, error, preserve) => {
    hooks.hasHooks.mockReturnValue(false);
    const pending = pendingFinal("recoverable final reply");
    const memory = await createPendingMemory(pending);
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
    await dispatchMemoryReply(memory, dispatcher, finalReply("recoverable final reply"));
    expect(memory.read()?.pendingFinalDelivery).toMatchObject({
      ...pending,
      deliveries: [{ id: "delivery-1", state: preserve ? "prepared" : "unknown" }],
    });
  });

  it.each(["prepared", "delivered"] as const)(
    "clears %s final custody after pre-delivery cancellation",
    async (state) => {
      hooks.hasHooks.mockReturnValue(false);
      const memory = await createPendingMemory(
        pendingFinal("policy-suppressed reply", {
          deliveries: [{ id: "delivery-1", state }],
        }),
      );
      const deliver = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createReplyDispatcher({
        deliver,
        beforeDeliver: (payload) =>
          state === "delivered" && payload.text === "policy-suppressed reply" ? payload : null,
      });

      const result = await dispatchMemoryReply(
        memory,
        dispatcher,
        finalReply("policy-suppressed reply"),
      );
      const receipt = await dispatcher.waitForIdle();
      expect(memory.read()?.pendingFinalDelivery).toBeUndefined();

      expect(deliver).not.toHaveBeenCalled();
      expect(receipt?.counts.final).toMatchObject({
        delivered: 0,
        cancelled: 2,
        failedBeforeSend: 0,
      });
      expect(result).toMatchObject({
        queuedFinal: true,
        noVisibleReplyFallbackDelivered: undefined,
        noVisibleReplyFallbackEligible: true,
      });
    },
  );

  function currentOperation() {
    const operation = replyRunRegistry.get(dispatchSessionKey);
    if (!operation) {
      throw new Error("expected dispatch reply operation");
    }
    return operation;
  }

  function createOperation(sessionId: string) {
    return createReplyOperation({
      sessionKey: dispatchSessionKey,
      sessionId,
      resetTriggered: false,
    });
  }

  it("delivers a generated final reply before queued follow-up admission", async () => {
    hooks.hasHooks.mockReturnValue(false);
    const deliveryOrder: string[] = [];
    const deliver = vi.fn(async () => {
      deliveryOrder.push("final");
    });
    const dispatcher = createReplyDispatcher({ deliver });
    let queuedOperation: ReturnType<typeof createReplyOperation> | undefined;

    try {
      const result = await dispatch(dispatcher, async () => {
        const operation = currentOperation();
        operation.fail("run_failed", new Error("provider failed"));
        runAfterReplyOperationClear(operation, () => {
          deliveryOrder.push("followup");
          queuedOperation = createOperation("queued-session");
        });
        return { text: "first reply" };
      });

      expect(result.queuedFinal).toBe(true);
      expect(deliver).toHaveBeenCalledExactlyOnceWith({ text: "first reply" }, { kind: "final" });
      await vi.waitFor(() => {
        expect(queuedOperation).toBeDefined();
      });
      expect(deliveryOrder).toEqual(["final", "followup"]);
      expect(replyRunRegistry.get(dispatchSessionKey)).toBe(queuedOperation);
    } finally {
      dispatcher.markComplete();
      queuedOperation?.complete();
    }
  });

  it.each([false, true])(
    "bounds finalization while preserving live TTS work (slow TTS=%s)",
    async (slowTts) => {
      vi.useFakeTimers();
      const gate = createDispatchGate();
      const dispatcher = createDispatcher();
      const text = slowTts ? "reply with slow TTS" : "late reply";
      let successor: ReturnType<typeof createReplyOperation> | undefined;
      hooks.hasHooks.mockReturnValue(false);
      if (slowTts) {
        ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (input: unknown) => {
          await gate.wait();
          return (input as { payload: ReplyPayload }).payload;
        });
      }
      try {
        const result = dispatch(dispatcher, async () => {
          const operation = currentOperation();
          operation.freezeAbort();
          if (!slowTts) {
            await gate.wait();
          }
          return { text };
        });
        await gate.started;
        await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);
        if (slowTts) {
          const active = replyRunRegistry.get(dispatchSessionKey);
          expect(active).toMatchObject({ result: null });
          expect(replyRunRegistry.abort(dispatchSessionKey)).toBe(false);
          gate.resolve();
          await expect(result).resolves.toMatchObject({ queuedFinal: true });
          expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text });
          expect(replyRunRegistry.get(dispatchSessionKey)).toBeUndefined();
        } else {
          await expect(result).resolves.toMatchObject({ queuedFinal: false });
          expect(replyRunRegistry.get(dispatchSessionKey)).toBeUndefined();
          successor = createOperation("successor-session");
          gate.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
          expect(replyRunRegistry.get(dispatchSessionKey)).toBe(successor);
        }
      } finally {
        gate.resolve();
        successor?.complete();
        await vi.runOnlyPendingTimersAsync();
        if (!slowTts) {
          expect([getActiveReplyRunCount(), vi.getTimerCount()]).toEqual([0, 0]);
        }
        vi.useRealTimers();
      }
    },
  );

  const repeatedPayload: ReplyPayload = {
    text: "repeat once",
    mediaUrls: ["file:///tmp/repeat.png"],
    channelData: { telegram: { parseMode: "MarkdownV2" } },
  };
  it.each([
    {
      name: "dedupes equivalent non-streaming final payload entries",
      replies: [
        repeatedPayload,
        { ...repeatedPayload },
        { ...repeatedPayload, videoAsNote: false },
      ],
      expected: [repeatedPayload],
    },
    {
      name: "preserves different native locations",
      replies: [
        { location: { latitude: 1, longitude: 2 } },
        { location: { latitude: 3, longitude: 4 } },
      ],
    },
    {
      name: "preserves normal and round videos sharing media",
      replies: [
        { mediaUrl: "file:///tmp/reply.mp4" },
        { mediaUrl: "file:///tmp/reply.mp4", videoAsNote: true },
      ],
    },
  ] satisfies Array<{ name: string; replies: ReplyPayload[]; expected?: ReplyPayload[] }>)(
    "$name",
    async ({ replies, expected = replies }) => {
      hooks.hasHooks.mockReturnValue(false);
      const dispatcher = createDispatcher();
      const result = await dispatch(dispatcher, async () => replies);
      expect(result.queuedFinal).toBe(true);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(expected.length);
      for (const [index, payload] of expected.entries()) {
        expect(dispatcher.sendFinalReply).toHaveBeenNthCalledWith(index + 1, payload);
      }
    },
  );
});
