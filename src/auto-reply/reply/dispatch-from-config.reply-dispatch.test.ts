// Tests dispatch-from-config reply dispatch integration and final payload routing.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { PluginHookReplyDispatchResult } from "../../plugins/hooks.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
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
} from "./dispatch-from-config.shared.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
let replyRunRegistry: typeof import("./reply-run-registry.js").replyRunRegistry;
let runAfterReplyOperationClear: typeof import("./reply-run-registry.js").runAfterReplyOperationClear;
let resetReplyRunRegistry: typeof import("./reply-run-registry.js").testing.resetReplyRunRegistry;

function firstRuntimeLoadCall() {
  return runtimePluginMocks.ensureRuntimePluginsLoaded.mock.calls[0]?.[0] as
    | { config?: unknown; workspaceDir?: unknown }
    | undefined;
}

function firstReplyDispatchCall() {
  return hookMocks.runner.runReplyDispatch.mock.calls[0] as
    | [
        {
          sessionKey?: string;
          toolsAllow?: string[];
          sendPolicy?: string;
          inboundAudio?: boolean;
        },
        {
          cfg?: unknown;
        },
      ]
    | undefined;
}

describe("dispatchReplyFromConfig reply_dispatch hook", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    const replyRunRegistryModule = await import("./reply-run-registry.js");
    createReplyOperation = replyRunRegistryModule.createReplyOperation;
    replyRunRegistry = replyRunRegistryModule.replyRunRegistry;
    runAfterReplyOperationClear = replyRunRegistryModule.runAfterReplyOperationClear;
    resetReplyRunRegistry = () => replyRunRegistryModule.testing.resetReplyRunRegistry();
  });

  beforeEach(() => {
    clearAgentHarnesses();
    resetReplyRunRegistry();
    setDiscordTestRegistry();
    resetInboundDedupe();
    mocks.routeReply.mockReset().mockResolvedValue({ ok: true, messageId: "mock" });
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
    sessionStoreMocks.loadSessionStore.mockReset().mockReturnValue({});
    sessionStoreMocks.readSessionEntry.mockReset().mockReturnValue(undefined);
    sessionStoreMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/mock-sessions.json");
    sessionStoreMocks.resolveSessionStoreEntry.mockReset().mockReturnValue({ existing: undefined });
    sessionStoreMocks.updateSessionStoreEntry.mockClear();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    acpManagerRuntimeMocks.getAcpSessionManager.mockImplementation(() => ({
      resolveSession: () => ({ kind: "none" as const }),
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
    agentEventMocks.onAgentEvent.mockReset().mockImplementation(() => () => {});
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    runtimePluginMocks.ensureRuntimePluginsLoaded.mockReset();
    resetPluginTtsAndThreadMocks();
  });

  it("returns handled dispatch results from plugins", async () => {
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      fastAbortResolver: async () => ({ handled: false, aborted: false }),
      formatAbortReplyTextResolver: () => "⚙️ Agent was aborted.",
      replyOptions: { toolsAllow: ["message"] },
      replyResolver: async () => ({ text: "model reply" }),
    });

    expect(runtimePluginMocks.ensureRuntimePluginsLoaded).toHaveBeenCalledOnce();
    const runtimeLoadCall = firstRuntimeLoadCall();
    expect(runtimeLoadCall?.config).toBe(emptyConfig);
    expect(typeof runtimeLoadCall?.workspaceDir).toBe("string");
    expect(String(runtimeLoadCall?.workspaceDir).length).toBeGreaterThan(0);

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledOnce();
    const [replyDispatchEvent, replyDispatchRuntime] = firstReplyDispatchCall() ?? [];
    expect(replyDispatchEvent?.sessionKey).toBe("agent:test:session");
    expect(replyDispatchEvent?.toolsAllow).toEqual(["message"]);
    expect(replyDispatchEvent?.sendPolicy).toBe("allow");
    expect(replyDispatchEvent?.inboundAudio).toBe(false);
    expect(replyDispatchRuntime?.cfg).toBe(emptyConfig);
    expect(result).toEqual({
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });
  });
  it("still applies send-policy deny after an unhandled plugin dispatch", async () => {
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: false,
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    } satisfies PluginHookReplyDispatchResult);

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: {
        ...emptyConfig,
        session: {
          sendPolicy: { default: "deny" },
        },
      },
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "model reply" }),
    });

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalled();
    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sendPolicyDenied: true,
      noVisibleReplyFallbackEligible: true,
    });
  });

  it("clears pending final delivery after final dispatch succeeds", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionKey: "agent:test:session",
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "durable reply",
      pendingFinalDeliveryCreatedAt: 1,
      pendingFinalDeliveryLastAttemptAt: 2,
      pendingFinalDeliveryAttemptCount: 3,
      pendingFinalDeliveryLastError: "previous failure",
      pendingFinalDeliveryContext: { source: "heartbeat" },
    };
    sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: sessionStoreMocks.currentEntry,
    });
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "durable reply" }),
    });

    expect(result.queuedFinal).toBe(true);
    expect(sessionStoreMocks.updateSessionStoreEntry).toHaveBeenCalledOnce();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryLastAttemptAt).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryAttemptCount).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryLastError).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryContext).toBeUndefined();
  });

  it("clears pending final delivery when abort fires after a successful final send (#89115)", async () => {
    // Regression for #89115: an abort that lands after the final reply has
    // shipped (here, during sendFinalReply) must still clear the pending-final
    // bookkeeping — otherwise pendingFinalDelivery stays true and the get-reply
    // redelivery short-circuit silently blocks every later inbound.
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionKey: "agent:test:session",
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "durable reply",
      pendingFinalDeliveryCreatedAt: 1,
      pendingFinalDeliveryLastAttemptAt: 2,
      pendingFinalDeliveryAttemptCount: 3,
      pendingFinalDeliveryLastError: "previous failure",
      pendingFinalDeliveryContext: { source: "heartbeat" },
      pendingFinalDeliveryIntentId: "intent-89115",
    };
    sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: sessionStoreMocks.currentEntry,
    });
    const abortController = new AbortController();
    const dispatcher = createDispatcher();
    vi.mocked(dispatcher.sendFinalReply).mockImplementation(() => {
      abortController.abort();
      return true;
    });

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { abortSignal: abortController.signal },
      replyResolver: async () => ({ text: "durable reply" }),
    });

    // Abort landed after delivery: the run is still surfaced as aborted
    // (queuedFinal:false), but the pending-final state is fully cleared.
    expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
    expect(result.queuedFinal).toBe(false);
    expect(sessionStoreMocks.updateSessionStoreEntry).toHaveBeenCalledOnce();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryLastAttemptAt).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryAttemptCount).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryLastError).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryContext).toBeUndefined();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryIntentId).toBeUndefined();
  });

  it("preserves pending final delivery when final dispatch fails", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    sessionStoreMocks.currentEntry = {
      sessionKey: "agent:test:session",
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: "durable reply",
      pendingFinalDeliveryCreatedAt: 1,
    };
    sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: sessionStoreMocks.currentEntry,
    });
    const dispatcher = createDispatcher();
    vi.mocked(dispatcher.sendFinalReply).mockReturnValue(false);

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "durable reply" }),
    });

    expect(result.queuedFinal).toBe(false);
    expect(sessionStoreMocks.updateSessionStoreEntry).not.toHaveBeenCalled();
    expect(sessionStoreMocks.currentEntry?.pendingFinalDelivery).toBe(true);
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryText).toBe("durable reply");
    expect(sessionStoreMocks.currentEntry?.pendingFinalDeliveryCreatedAt).toBe(1);
  });

  it("delivers a generated final reply before queued follow-up admission", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createDispatcher();
    const deliveryOrder: string[] = [];
    let queuedOperation: ReturnType<typeof createReplyOperation> | undefined;
    vi.mocked(dispatcher.sendFinalReply).mockImplementation(() => {
      deliveryOrder.push("final");
      return true;
    });

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
      expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "first reply" });
      await vi.waitFor(() => {
        expect(queuedOperation).toBeDefined();
      });
      expect(deliveryOrder).toEqual(["final", "followup"]);
      expect(replyRunRegistry.get("agent:test:session")).toBe(queuedOperation);
    } finally {
      queuedOperation?.complete();
    }
  });

  it("clears the reply lane but defers follow-up admission until final delivery settles", async () => {
    const deliveryOrder: string[] = [];
    let startDelivery: () => void = () => {};
    const deliveryStarted = new Promise<void>((resolve) => {
      startDelivery = resolve;
    });
    let releaseDelivery: () => void = () => {};
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        deliveryOrder.push("final-start");
        startDelivery();
        await deliveryGate;
        deliveryOrder.push("final-end");
      },
    });
    let queuedOperation: ReturnType<typeof createReplyOperation> | undefined;
    const abortController = new AbortController();
    hookMocks.runner.runReplyDispatch.mockImplementation(async (_event, contextValue) => {
      const operation = replyRunRegistry.get("agent:test:session");
      if (!operation) {
        throw new Error("expected dispatch reply operation");
      }
      runAfterReplyOperationClear(operation, () => {
        deliveryOrder.push("followup");
        queuedOperation = createReplyOperation({
          sessionKey: "agent:test:session",
          sessionId: "queued-session",
          resetTriggered: false,
        });
      });
      const context = contextValue as { dispatcher: typeof dispatcher };
      return {
        handled: true,
        queuedFinal: context.dispatcher.sendFinalReply({ text: "first reply" }),
        counts: context.dispatcher.getQueuedCounts(),
      };
    });

    try {
      const dispatchPromise = dispatchReplyFromConfig({
        ctx: createHookCtx(),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: { abortSignal: abortController.signal },
      });

      await deliveryStarted;
      const result = await dispatchPromise;

      expect(result.queuedFinal).toBe(true);
      expect(replyRunRegistry.isActive("agent:test:session")).toBe(false);
      expect(deliveryOrder).toEqual(["final-start"]);
      expect(queuedOperation).toBeUndefined();

      abortController.abort();
      await Promise.resolve();
      expect(queuedOperation).toBeUndefined();

      releaseDelivery();
      await dispatcher.waitForIdle();
      await vi.waitFor(() => {
        expect(queuedOperation).toBeDefined();
      });

      expect(deliveryOrder).toEqual(["final-start", "final-end", "followup"]);
      expect(replyRunRegistry.get("agent:test:session")).toBe(queuedOperation);
    } finally {
      releaseDelivery();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      queuedOperation?.complete();
    }
  });
});
