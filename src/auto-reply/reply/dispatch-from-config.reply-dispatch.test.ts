// Tests dispatch-from-config reply dispatch integration and final payload routing.
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
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import type { PluginHookReplyDispatchResult } from "../../plugins/hooks.test-fixtures.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
let getActiveReplyRunCount: typeof import("./reply-run-registry.registry.js").getActiveReplyRunCount;
let replyRunRegistry: typeof import("./reply-run-registry.js").replyRunRegistry;
let runAfterReplyOperationClear: typeof import("./reply-run-registry.js").runAfterReplyOperationClear;
let resetReplyRunRegistry: typeof import("./reply-run-registry.test-support.js").testing.resetReplyRunRegistry;

const REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS = 60_000;

function pendingFinalDelivery(
  text: string,
  overrides: {
    createdAt?: number;
    context?: Record<string, unknown>;
    deliveries?: Array<{
      id: string;
      state: "prepared" | "queued" | "delivered" | "suppressed" | "unknown";
    }>;
    intentId?: string;
  } = {},
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

function createInternalHookCtx(): FinalizedMsgContext {
  return { ...createHookCtx(), InputProvenance: { kind: "internal_system" } };
}

function pendingFinalReply(
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
        sessionKey: "agent:test:session",
        storePath: "/tmp/mock-sessions.json",
      },
    },
  );
}

describe("dispatchReplyFromConfig reply_dispatch hook", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    const replyRunRegistryModule = await import("./reply-run-registry.js");
    createReplyOperation = replyRunRegistryModule.createReplyOperation;
    ({ getActiveReplyRunCount } = await import("./reply-run-registry.registry.js"));
    replyRunRegistry = replyRunRegistryModule.replyRunRegistry;
    runAfterReplyOperationClear = replyRunRegistryModule.runAfterReplyOperationClear;
    const { testing } = await import("./reply-run-registry.test-support.js");
    resetReplyRunRegistry = () => testing.resetReplyRunRegistry();
  });

  beforeEach(() => {
    clearAgentHarnesses();
    resetReplyRunRegistry();
    setDiscordTestRegistry();
    resetInboundDedupe();
    mocks.routeReply
      .mockReset()
      .mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset().mockResolvedValue({
      handled: false,
      aborted: false,
    });
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    hookMocks.runner.runInboundClaim.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome.mockReset().mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runMessageReceived.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runBeforeDispatch.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockReset().mockResolvedValue(undefined);
    internalHookMocks.createInternalHookEvent.mockReset();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset().mockResolvedValue(undefined);
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
    acpMocks.requireAcpRuntimeBackend.mockReset();
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStoreEntry.mockReset();
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(
      () => sessionStoreMocks.currentEntry,
    );
    sessionStoreMocks.resolveSessionStorePathCore
      .mockReset()
      .mockReturnValue("/tmp/mock-sessions.json");
    sessionStoreMocks.updateSessionEntry.mockClear();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    acpManagerRuntimeMocks.getAcpSessionManager.mockImplementation(() => ({
      resolveSessionAsync: async () => ({ kind: "none" as const }),
      getObservabilitySnapshot: () => ({
        runtimeCache: { activeSessions: 0, idleTtlMs: 0, evictedTotal: 0 },
        turns: {
          active: 0,
          queueDepth: 0,
          completed: 0,
          failed: 0,
          averageLatencyMs: 0,
          maxLatencyMs: 0,
        },
        errorsByCode: {},
      }),
      runTurn: vi.fn(),
    }));
    agentEventMocks.emitAgentEvent.mockReset();
    agentEventMocks.emitAgentAuditEvent.mockReset();
    agentEventMocks.onAgentEvent.mockReset().mockImplementation(() => () => {});
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    runtimePluginMocks.loadAgentRuntimePluginRegistryHandle.mockReset();
    runtimePluginMocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(
      runtimePluginMocks.pluginRegistry,
    );
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
          const result = await dispatchReplyFromConfig({
            ctx: { ...createHookCtx(), SessionKey: sessionKey, AgentId: "qa" },
            cfg,
            dispatcher: createDispatcher(),
            replyResolver: async () => ({ text: "selected owner reply" }),
          });
          expect(result.queuedFinal).toBe(true);
        },
      );
    },
  );

  it("still applies send-policy deny after an unhandled plugin dispatch", async () => {
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: false,
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    } satisfies PluginHookReplyDispatchResult);
    const dispatcher = createDispatcher();

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
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
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    const replyResolver = vi.fn(async (_ctx, options) => {
      expect(options?.admittedSessionSettings).toEqual(admittedSessionSettings);
      return { text: "model reply" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyOptions: { admittedSessionSettings },
      replyResolver,
    });

    expect(hookMocks.runner.runReplyDispatch).not.toHaveBeenCalled();
    expect(admittedSessionSettings.toolOverrides.mcpToolsDeny.github).toEqual(["delete_issue"]);
    expect(replyResolver).toHaveBeenCalledOnce();
  });

  async function dispatchPastStalledHook(params: {
    pending: ReturnType<typeof pendingFinalDelivery>;
    replies: ReplyPayload[];
    stalledIndex: number;
    afterStall?: () => void;
  }) {
    vi.useFakeTimers();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionId: "session-1",
      sessionKey: "agent:test:session",
      pendingFinalDelivery: params.pending,
    };
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
      const result = withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx: createInternalHookCtx(),
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async () => params.replies,
          }),
      });
      await hookStarted.promise;
      params.afterStall?.();
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
      expect(vi.getTimerCount()).toBe(0);
      return deliver;
    } finally {
      vi.useRealTimers();
    }
  }

  it("clears pending final delivery when a later queued final succeeds", async () => {
    const deliver = await dispatchPastStalledHook({
      pending: pendingFinalDelivery("durable reply"),
      replies: [{ text: "first" }, pendingFinalReply("durable reply")],
      stalledIndex: 1,
    });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "durable reply" }),
      expect.objectContaining({ kind: "final" }),
    );
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
  });

  it("records each pending-final delivery without rewriting aggregate text", async () => {
    await dispatchPastStalledHook({
      pending: pendingFinalDelivery("auxiliary\n\ndurable reply", {
        deliveries: [
          { id: "delivery-auxiliary", state: "prepared" },
          { id: "delivery-durable", state: "prepared" },
        ],
      }),
      replies: [
        pendingFinalReply("auxiliary", { deliveryId: "delivery-auxiliary" }),
        pendingFinalReply("durable reply", { deliveryId: "delivery-durable" }),
      ],
      stalledIndex: 2,
    });
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toEqual(
      pendingFinalDelivery("auxiliary\n\ndurable reply", {
        deliveries: [
          { id: "delivery-auxiliary", state: "delivered" },
          { id: "delivery-durable", state: "prepared" },
        ],
      }),
    );
  });

  it("does not let an older settlement rewrite a newer pending-final intent", async () => {
    const newer = pendingFinalDelivery("newer reply", { createdAt: 2, intentId: "newer-intent" });
    await dispatchPastStalledHook({
      pending: pendingFinalDelivery("older reply", { intentId: "older-intent" }),
      replies: [pendingFinalReply("older reply", { intentId: "older-intent" })],
      stalledIndex: 1,
      afterStall: () => {
        sessionStoreMocks.currentEntry = {
          ...sessionStoreMocks.currentEntry,
          pendingFinalDelivery: newer,
        };
      },
    });
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toEqual(
      pendingFinalDelivery("newer reply", { createdAt: 2, intentId: "newer-intent" }),
    );
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
    sessionStoreMocks.currentEntry = {
      sessionId: "session-1",
      sessionKey: "agent:test:session",
      pendingFinalDelivery: pending,
    };
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
    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async () => pendingFinalReply("recoverable final reply"),
        }),
    });
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toMatchObject({
      ...pending,
      deliveries: [{ id: "delivery-1", state: preserve ? "prepared" : "unknown" }],
    });
  });

  it("clears pending final delivery after intentional pre-delivery cancellation", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionId: "session-1",
      sessionKey: "agent:test:session",
      pendingFinalDelivery: pendingFinalDelivery("policy-suppressed reply"),
    };
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: () => null,
    });

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => pendingFinalReply("policy-suppressed reply"),
    });
    const receipt = await dispatcher.waitForIdle();
    await vi.waitFor(() => {
      expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
    });

    expect(result.queuedFinal).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    expect(receipt?.counts.final).toMatchObject({
      delivered: 0,
      cancelled: 2,
      failedBeforeSend: 0,
    });
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    expect(result.noVisibleReplyFallbackEligible).toBe(true);
  });

  it("delivers a generated final reply before queued follow-up admission", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const deliveryOrder: string[] = [];
    const deliver = vi.fn(async () => {
      deliveryOrder.push("final");
    });
    const dispatcher = createReplyDispatcher({ deliver });
    let queuedOperation: ReturnType<typeof createReplyOperation> | undefined;

    try {
      const result = await dispatchReplyFromConfig({
        ctx: createHookCtx(),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => {
          const operation = replyRunRegistry.get("agent:test:session");
          if (!operation) {
            throw new Error("expected dispatch reply operation");
          }
          operation.fail("run_failed", new Error("provider failed"));
          runAfterReplyOperationClear(operation, () => {
            deliveryOrder.push("followup");
            queuedOperation = createReplyOperation({
              sessionKey: "agent:test:session",
              sessionId: "queued-session",
              resetTriggered: false,
            });
          });
          return { text: "first reply" };
        },
      });

      expect(result.queuedFinal).toBe(true);
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver).toHaveBeenCalledWith({ text: "first reply" }, { kind: "final" });
      await vi.waitFor(() => {
        expect(queuedOperation).toBeDefined();
      });
      expect(deliveryOrder).toEqual(["final", "followup"]);
      expect(replyRunRegistry.get("agent:test:session")).toBe(queuedOperation);
    } finally {
      dispatcher.markComplete();
      queuedOperation?.complete();
    }
  });

  it("releases a stalled finalizing dispatch and rejects its late reply", async () => {
    vi.useFakeTimers();
    const ownerStarted = createDeferred();
    const releaseOwner = createDeferred();
    const dispatcher = createDispatcher();
    let successor: ReturnType<typeof createReplyOperation> | undefined;
    hookMocks.runner.hasHooks.mockReturnValue(false);

    try {
      const dispatchPromise = dispatchReplyFromConfig({
        ctx: createHookCtx(),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => {
          const operation = replyRunRegistry.get("agent:test:session");
          if (!operation) {
            throw new Error("expected dispatch reply operation");
          }
          operation.freezeAbort();
          ownerStarted.resolve();
          await releaseOwner.promise;
          return { text: "late reply" };
        },
      });

      await ownerStarted.promise;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);
      await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: false });

      expect(replyRunRegistry.get("agent:test:session")).toBeUndefined();
      successor = createReplyOperation({
        sessionKey: "agent:test:session",
        sessionId: "successor-session",
        resetTriggered: false,
      });

      releaseOwner.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(replyRunRegistry.get("agent:test:session")).toBe(successor);
    } finally {
      releaseOwner.resolve();
      successor?.complete();
      await vi.runOnlyPendingTimersAsync();
      expect(getActiveReplyRunCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it("keeps bounded TTS fallback work alive past the default finalization lease", async () => {
    vi.useFakeTimers();
    const ttsStarted = createDeferred();
    const releaseTts = createDeferred();
    const dispatcher = createDispatcher();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (paramsUnknown: unknown) => {
      ttsStarted.resolve();
      await releaseTts.promise;
      return (paramsUnknown as { payload: ReplyPayload }).payload;
    });

    try {
      const dispatchPromise = dispatchReplyFromConfig({
        ctx: createHookCtx(),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => {
          const operation = replyRunRegistry.get("agent:test:session");
          if (!operation) {
            throw new Error("expected dispatch reply operation");
          }
          operation.freezeAbort();
          return { text: "reply with slow TTS" };
        },
      });

      await ttsStarted.promise;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS);

      const active = replyRunRegistry.get("agent:test:session");
      expect(active).toBeDefined();
      expect(active?.result).toBeNull();
      expect(replyRunRegistry.abort("agent:test:session")).toBe(false);

      releaseTts.resolve();
      await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: true });
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "reply with slow TTS" });
      expect(replyRunRegistry.get("agent:test:session")).toBeUndefined();
    } finally {
      releaseTts.resolve();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("dedupes equivalent non-streaming final payload entries for one turn", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createDispatcher();
    const replyPayload = {
      text: "repeat once",
      mediaUrls: ["file:///tmp/repeat.png"],
      channelData: { telegram: { parseMode: "MarkdownV2" } },
    } satisfies ReplyPayload;

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => [
        replyPayload,
        { ...replyPayload },
        { ...replyPayload, videoAsNote: false },
      ],
    });

    expect(result.queuedFinal).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(replyPayload);
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
      hookMocks.runner.hasHooks.mockReturnValue(false);
      const dispatcher = createDispatcher();

      const result = await dispatchReplyFromConfig({
        ctx: createHookCtx(),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => replies,
      });

      expect(result.queuedFinal).toBe(true);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(2);
      expect(dispatcher.sendFinalReply).toHaveBeenNthCalledWith(1, replies[0]);
      expect(dispatcher.sendFinalReply).toHaveBeenNthCalledWith(2, replies[1]);
    },
  );
});
