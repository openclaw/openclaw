import { vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { RestartSentinelSessionFixture as LoadedSessionEntry } from "./server-restart-sentinel.test-support.js";

type RestartSentinel = NonNullable<
  Awaited<ReturnType<typeof import("../infra/restart-sentinel.js").readRestartSentinel>>
>;

type RecordInboundSessionAndDispatchReplyParams = Parameters<
  typeof import("../channels/turn/lifecycle.js").dispatchAssembledChannelTurn
>[0] & {
  deliver: (payload: { text?: string; replyToId?: string | null }) => Promise<void>;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
};
type InProcessDispatchMock = (
  method: string,
  params: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
type AdvanceSessionDeliveryAgentRunMock =
  typeof import("../infra/session-delivery-queue-storage.js").advanceSessionDeliveryAgentRun;
type DeferSessionDeliveryMock =
  typeof import("../infra/session-delivery-queue-storage.js").deferSessionDelivery;
type FailSessionDeliveryMock =
  typeof import("../infra/session-delivery-queue-storage.js").failSessionDelivery;
type MergeSessionDeliveryPreparedMediaBlocksMock =
  typeof import("../infra/session-delivery-queue-storage.js").mergeSessionDeliveryPreparedMediaBlocks;
type RecoverPendingSessionDeliveriesMock =
  typeof import("../infra/session-delivery-queue-recovery.js").recoverPendingSessionDeliveries;
type DrainPendingSessionDeliveryMock =
  typeof import("../infra/session-delivery-queue-recovery.js").drainPendingSessionDelivery;
type AppendAssistantMessageToSessionTranscriptMock =
  typeof import("../config/sessions/transcript.js").appendAssistantMessageToSessionTranscript;
type CreateManagedOutgoingMediaBlocksMock =
  typeof import("./managed-image-attachments.js").createManagedOutgoingMediaBlocks;
type AttachManagedOutgoingMediaToMessageMock =
  typeof import("./managed-image-attachments.js").attachManagedOutgoingMediaToMessage;
type EnrichAssistantTranscriptMediaForRunMock =
  typeof import("./server-methods/chat-transcript-persistence.js").enrichAssistantTranscriptMediaForRun;

const mocks = vi.hoisted(() => {
  const state = {
    initialOutboundDelivery: null as Record<string, unknown> | null,
  };

  return {
    resolveSessionAgentId: vi.fn(() => "agent-from-key"),
    getRuntimeConfig: vi.fn<() => import("../config/types.openclaw.js").OpenClawConfig>(),
    resolveSessionTarget:
      vi.fn<
        typeof import("./session-utils-store-worker.js").resolveGatewaySessionStoreTargetInWorker
      >(),
    setInitialOutboundDelivery(value: Record<string, unknown> | null) {
      state.initialOutboundDelivery = value;
    },
    takeInitialOutboundDelivery() {
      const value = state.initialOutboundDelivery;
      state.initialOutboundDelivery = null;
      return value;
    },
    dispatchGatewayMethodInProcess: vi.fn<InProcessDispatchMock>(),
    readRestartSentinel: vi.fn<() => Promise<RestartSentinel>>(),
    finalizeUpdateRestartSentinelRunningVersion: vi.fn(async () => null),
    clearSentinel: vi.fn(async () => true),
    formatRestartSentinelMessage: vi.fn(() => "restart message"),
    summarizeRestartSentinel: vi.fn(() => "restart summary"),
    resolveSystemMainSessionTarget: vi.fn(() => ({
      agentId: "ops",
      sessionKey: "agent:ops:main",
    })),
    parseSessionThreadInfo: vi.fn(
      (): { baseSessionKey: string | null | undefined; threadId: string | undefined } => ({
        baseSessionKey: null,
        threadId: undefined,
      }),
    ),
    loadSessionEntry:
      vi.fn<
        (
          sessionKey: string,
          options?: Parameters<typeof import("./session-utils.js").loadSessionEntry>[1],
        ) => LoadedSessionEntry
      >(),
    deliveryContextFromSession: vi.fn<
      typeof import("../utils/delivery-context.read.js").deliveryContextFromSession
    >(() => undefined),
    mergeDeliveryContext: vi.fn<
      typeof import("../utils/delivery-context.shared.js").mergeDeliveryContext
    >((a, b) => ({ ...b, ...a })),
    getChannelPlugin: vi.fn((): ChannelPlugin | undefined => undefined),
    normalizeChannelId: vi.fn<(channel?: string | null) => string | null>(),
    resolveOutboundTarget: vi.fn(((_params?: { to?: string }) => ({
      ok: true as const,
      to: "+15550002",
    })) as (params?: { to?: string }) => { ok: true; to: string } | { ok: false; error: Error }),
    deliverOutboundPayloads: vi.fn(async (_params?: Record<string, unknown>) => [
      { channel: "whatsapp", messageId: "msg-1" },
    ]),
    enqueueDeliveryOnce: vi.fn(async (_payload: unknown, id: string) => ({ id, created: true })),
    findDeliveryIntentOwner: vi.fn<
      () => Promise<{
        namespace: "prepared" | "preparing" | "migration" | "legacy-preparing" | "legacy";
        status: "pending" | "failed" | "completed";
      } | null>
    >(async () => null),
    ackDelivery: vi.fn(async (_id: string) => {}),
    failDelivery: vi.fn(async () => {}),
    failDeliveryAfterPlatformSend: vi.fn(async () => {}),
    failDeliveryBeforePlatformSend: vi.fn(async () => {}),
    failPendingDelivery: vi.fn(async () => ({ status: "failed" as const })),
    loadPendingDelivery: vi.fn(async () => null),
    drainPendingDeliveries: vi.fn(async () => {}),
    reserveDeliveryAttempt: vi.fn(async () => ({
      status: "reserved" as const,
      attemptCount: 1,
    })),
    withActiveDeliveryClaim: vi.fn(async (_id: string, fn: () => Promise<unknown>) => ({
      status: "claimed" as const,
      value: await fn(),
    })),
    withStableDeliveryPreparation: vi.fn(),
    captureSessionEventTarget:
      vi.fn<
        typeof import("../auto-reply/reply/session-event-handoff.js").captureSessionEventTargetForHost
      >(),
    enqueueSessionEvent:
      vi.fn<
        typeof import("../auto-reply/reply/session-event-handoff.js").enqueueSessionEventForHost
      >(),
    enqueueSessionDelivery: vi.fn(),
    advanceSessionDeliveryAgentRun: vi.fn<AdvanceSessionDeliveryAgentRunMock>(async () => {}),
    deferSessionDelivery: vi.fn<DeferSessionDeliveryMock>(async () => {}),
    failSessionDelivery: vi.fn<FailSessionDeliveryMock>(async () => {}),
    mergeSessionDeliveryPreparedMediaBlocks: vi.fn<MergeSessionDeliveryPreparedMediaBlocksMock>(
      async (_id, _mediaUrl, blocks) => blocks,
    ),
    markSessionDeliveryAttemptStarted: vi.fn(async () => {}),
    markSessionDeliverySettlement: vi.fn(async () => {}),
    appendAssistantMessageToSessionTranscript: vi.fn<AppendAssistantMessageToSessionTranscriptMock>(
      async (params) => {
        const { appendRestartSentinelTranscriptReceipt } =
          await import("./server-restart-sentinel.test-support.js");
        return appendRestartSentinelTranscriptReceipt(params);
      },
    ),
    createManagedOutgoingMediaBlocks: vi.fn<CreateManagedOutgoingMediaBlocksMock>(async (params) =>
      (params.items ?? []).map((item) => ({
        type: item.mimeType?.startsWith("audio/") ? "audio" : "image",
        artifactId: `artifact:${item.url}`,
        url: `/api/chat/media/outgoing/${encodeURIComponent(params.sessionKey)}/${encodeURIComponent(item.url)}/full`,
        openUrl: `/api/chat/media/outgoing/${encodeURIComponent(params.sessionKey)}/${encodeURIComponent(item.url)}/full`,
      })),
    ),
    attachManagedOutgoingMediaToMessage: vi.fn<AttachManagedOutgoingMediaToMessageMock>(
      async () => true,
    ),
    enrichAssistantTranscriptMediaForRun: vi.fn<EnrichAssistantTranscriptMediaForRunMock>(
      async () => null,
    ),
    removeCronRunContinuationSessionIfIdle: vi.fn(async () => {}),
    settleCorrelatedSubagentDelivery: vi.fn(async () => {}),
    loadPendingSessionDelivery: vi.fn(),
    drainPendingSessionDelivery: vi.fn<DrainPendingSessionDeliveryMock>(),
    recoverPendingSessionDeliveries: vi.fn<RecoverPendingSessionDeliveriesMock>(),
    resolveAgentConfig: vi.fn(() => undefined),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-test-workspace"),
    resolveDefaultAgentId: vi.fn(() => "main"),
    recordInboundSessionAndDispatchReply: vi.fn(
      async (_params: RecordInboundSessionAndDispatchReplyParams) => {},
    ),
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.unmock("./server-restart-sentinel.js");
vi.resetModules();

vi.mock(
  "../agents/subagents/completion/subagent-completion-delivery.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../agents/subagents/completion/subagent-completion-delivery.js")
    >()),
    settleCorrelatedSubagentDelivery: mocks.settleCorrelatedSubagentDelivery,
  }),
);

vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveAgentConfig: mocks.resolveAgentConfig,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveSessionAgentId: mocks.resolveSessionAgentId,
}));

vi.mock("../infra/restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/restart-sentinel.js")>()),
  finalizeUpdateRestartSentinelRunningVersion: mocks.finalizeUpdateRestartSentinelRunningVersion,
  readRestartSentinel: mocks.readRestartSentinel,
  clearRestartSentinelIfRevision: mocks.clearSentinel,
  formatRestartSentinelMessage: mocks.formatRestartSentinelMessage,
  summarizeRestartSentinel: mocks.summarizeRestartSentinel,
}));

vi.mock("../infra/session-delivery-queue-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../infra/session-delivery-queue-storage.js")>();
  mocks.enqueueSessionDelivery.mockImplementation(actual.enqueueSessionDelivery);
  mocks.deferSessionDelivery.mockImplementation(async (id, delayMs, queueContext) => {
    if (await actual.loadPendingSessionDelivery(id, queueContext)) {
      await actual.deferSessionDelivery(id, delayMs, queueContext);
    }
  });
  mocks.failSessionDelivery.mockImplementation(async (id, error, queueContext, options) => {
    if (await actual.loadPendingSessionDelivery(id, queueContext)) {
      await actual.failSessionDelivery(id, error, queueContext, options);
    }
  });
  mocks.mergeSessionDeliveryPreparedMediaBlocks.mockImplementation(
    async (id, mediaUrl, blocks, queueContext) => {
      if (await actual.loadPendingSessionDelivery(id, queueContext)) {
        return await actual.mergeSessionDeliveryPreparedMediaBlocks(
          id,
          mediaUrl,
          blocks,
          queueContext,
        );
      }
      return blocks;
    },
  );
  mocks.loadPendingSessionDelivery.mockImplementation(actual.loadPendingSessionDelivery);
  return {
    ...actual,
    advanceSessionDeliveryAgentRun: mocks.advanceSessionDeliveryAgentRun,
    deferSessionDelivery: mocks.deferSessionDelivery,
    failSessionDelivery: mocks.failSessionDelivery,
    mergeSessionDeliveryPreparedMediaBlocks: mocks.mergeSessionDeliveryPreparedMediaBlocks,
    enqueueSessionDelivery: mocks.enqueueSessionDelivery,
    loadPendingSessionDelivery: mocks.loadPendingSessionDelivery,
    markSessionDeliveryAttemptStarted: mocks.markSessionDeliveryAttemptStarted,
    markSessionDeliverySettlement: mocks.markSessionDeliverySettlement,
  };
});

vi.mock("../infra/session-delivery-queue-recovery.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../infra/session-delivery-queue-recovery.js")>();
  mocks.drainPendingSessionDelivery.mockImplementation(actual.drainPendingSessionDelivery);
  mocks.recoverPendingSessionDeliveries.mockImplementation(actual.recoverPendingSessionDeliveries);
  return {
    ...actual,
    drainPendingSessionDelivery: mocks.drainPendingSessionDelivery,
    recoverPendingSessionDeliveries: mocks.recoverPendingSessionDeliveries,
  };
});

// mock-isolation: Observe continuation cleanup without deleting session rows or descendant state.
vi.mock("../cron/run-continuation-cleanup.js", () => ({
  removeCronRunContinuationSessionIfIdle: mocks.removeCronRunContinuationSessionIfIdle,
}));

// mock-isolation: Control transcript publication outcomes without writing real session transcripts.
vi.mock("../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));

vi.mock("./managed-image-attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-image-attachments.js")>()),
  createManagedOutgoingMediaBlocks: mocks.createManagedOutgoingMediaBlocks,
  attachManagedOutgoingMediaToMessage: mocks.attachManagedOutgoingMediaToMessage,
}));

vi.mock("./server-methods/chat-transcript-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-methods/chat-transcript-persistence.js")>()),
  enrichAssistantTranscriptMediaForRun: mocks.enrichAssistantTranscriptMediaForRun,
}));

vi.mock("../config/sessions/main-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/main-session.js")>()),
  resolveSystemMainSessionTarget: mocks.resolveSystemMainSessionTarget,
}));

// mock-isolation: Sentinel cases own their config snapshot without config I/O or runtime cache mutation.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: mocks.getRuntimeConfig }));

vi.mock("../channels/plugins/session-conversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/session-conversation.js")>()),
  resolveSessionThreadInfo: mocks.parseSessionThreadInfo,
}));

// mock-isolation: Sentinel fixtures supply thread metadata independently of the loaded plugin registry.
vi.mock("../channels/plugins/session-thread-info-loaded.js", () => ({
  resolveLoadedSessionThreadInfo: mocks.parseSessionThreadInfo,
}));

vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: mocks.loadSessionEntry,
}));
// mock-isolation: Use the harness session rows without starting store discovery or worker reads.
vi.mock("./session-utils-store-worker.js", () => ({
  resolveGatewaySessionStoreTargetInWorker: mocks.resolveSessionTarget,
}));

vi.mock("../utils/delivery-context.read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/delivery-context.read.js")>()),
  deliveryContextFromSession: mocks.deliveryContextFromSession,
}));

vi.mock("../utils/delivery-context.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/delivery-context.shared.js")>()),
  mergeDeliveryContext: mocks.mergeDeliveryContext,
}));

vi.mock("../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  );
  return {
    ...actual,
    getChannelPlugin: mocks.getChannelPlugin,
    normalizeChannelId: mocks.normalizeChannelId.mockImplementation(
      (channel?: string | null) =>
        actual.normalizeChannelId(channel) ??
        (typeof channel === "string" && channel.trim().length > 0
          ? channel.trim().toLowerCase()
          : null),
    ),
  };
});

// mock-isolation: Drive reply and delivery callbacks without recording inbound state or executing agents.
vi.mock("../channels/turn/lifecycle.js", () => ({
  dispatchAssembledChannelTurn: async (params: {
    delivery: {
      preparePayload?: (payload: { text?: string; replyToId?: string | null }) => {
        text?: string;
        replyToId?: string | null;
      };
      deliver: (payload: { text?: string; replyToId?: string | null }) => Promise<void>;
      onError?: (err: unknown, info: { kind: string }) => void;
    };
  }) => {
    await mocks.recordInboundSessionAndDispatchReply({
      ...params,
      deliver: async (payload: { text?: string; replyToId?: string | null }) =>
        params.delivery.deliver(params.delivery.preparePayload?.(payload) ?? payload),
      onDispatchError: (err: unknown, info: { kind: string }) =>
        params.delivery.onError?.(err, info),
    } as unknown as RecordInboundSessionAndDispatchReplyParams);
    return {
      dispatched: true,
      dispatchResult: { observedReplyDelivery: true },
    };
  },
}));

vi.mock("./server-recovery-runtime-context.js", async () => ({
  ...(await vi.importActual<typeof import("./server-recovery-runtime-context.js")>(
    "./server-recovery-runtime-context.js",
  )),
  dispatchGatewayLifecycleMethod: mocks.dispatchGatewayMethodInProcess,
}));

// mock-isolation: Sentinel cases control route success and failure without resolving channel plugins.
vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

// mock-isolation: Keep platform sends synthetic while exercising sentinel delivery settlement.
vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

// mock-isolation: Outbound custody and attempts use fixture state instead of the shared SQLite queue.
vi.mock("../infra/outbound/delivery-queue-storage.js", () => ({
  ackDelivery: mocks.ackDelivery,
  failDelivery: mocks.failDelivery,
  failDeliveryAfterPlatformSend: mocks.failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend: mocks.failDeliveryBeforePlatformSend,
  findDeliveryIntentOwner: mocks.findDeliveryIntentOwner,
  loadPendingDelivery: async () =>
    mocks.takeInitialOutboundDelivery() ?? (await mocks.loadPendingDelivery()),
  reserveDeliveryAttempt: mocks.reserveDeliveryAttempt,
}));
vi.mock("../infra/outbound/delivery-queue-ack.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/outbound/delivery-queue-ack.js")>()),
  failPendingDelivery: mocks.failPendingDelivery,
}));
// mock-isolation: Control replay claims and drain outcomes without the real recovery coordinator.
vi.mock("../infra/outbound/delivery-queue-recovery.js", () => ({
  drainPendingDeliveriesCore: mocks.drainPendingDeliveries,
  withActiveDeliveryClaim: mocks.withActiveDeliveryClaim,
}));

// mock-isolation: Control preparation ownership without SQLite leases or renewal timers.
vi.mock("../infra/outbound/delivery-queue-preparation.js", () => ({
  withStableDeliveryPreparation: mocks.withStableDeliveryPreparation,
}));

// mock-isolation: Supply prepared payloads without channel adapters or global modifying hooks.
vi.mock("../infra/outbound/deliver-prepare.js", () => ({
  prepareOutboundPayloadBatch: vi.fn(async (params: { payloads: unknown[] }) => ({
    schemaVersion: 1,
    sourcePayloadCount: params.payloads.length,
    channelNormalized: true,
    entries: params.payloads.map((payload, sourceIndex) => ({
      sourceIndex,
      status: "accepted",
      payload,
      replyHookChanged: false,
      messageHookChanged: false,
      preparedMediaCount: 0,
    })),
  })),
}));

// mock-isolation: Keep outbound admission in fixture custody without staging media or writing queue rows.
vi.mock("../infra/outbound/deliver-queue-admission.js", () => ({
  stageAndEnqueueOutboundDelivery: vi.fn(
    async (
      params: { deliveryIntentId?: string; payloads: unknown[] },
      preparedBatch: Record<string, unknown>,
    ) => {
      const queued = await mocks.enqueueDeliveryOnce(params, params.deliveryIntentId ?? "");
      if (queued.created) {
        mocks.setInitialOutboundDelivery({
          ...params,
          id: queued.id,
          enqueuedAt: 1,
          retryCount: 0,
          attemptCount: 0,
          preparedBatch,
        });
      }
      return queued;
    },
  ),
}));

// mock-isolation: Control durable send outcomes without the channel transport and queue runtime.
vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: vi.fn(async (params: Record<string, unknown>) => {
    try {
      const results = await mocks.deliverOutboundPayloads(params);
      return { status: "sent", results };
    } catch (error) {
      return { status: "failed", error };
    }
  }),
}));

vi.mock("./server-restart-update-run.js", async () => {
  const actual = await vi.importActual<typeof import("./server-restart-update-run.js")>(
    "./server-restart-update-run.js",
  );
  return { ...actual, finalizeRestartUpdateRun: vi.fn(actual.finalizeRestartUpdateRun) };
});

// mock-isolation: Control restart adoption receipts without admitting real session reply work.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: mocks.captureSessionEventTarget,
  enqueueSessionEventForHost: mocks.enqueueSessionEvent,
}));

vi.mock("../logging/subsystem.js", async () => {
  const actual =
    await vi.importActual<typeof import("../logging/subsystem.js")>("../logging/subsystem.js");
  const logger = {
    debug: mocks.logDebug,
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    isEnabled: vi.fn(() => false),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return {
    ...actual,
    createSubsystemLogger: vi.fn((subsystem: string) =>
      subsystem === "gateway/restart-sentinel" || subsystem === "gateway/update-run"
        ? logger
        : actual.createSubsystemLogger(subsystem),
    ),
  };
});

const {
  deliverQueuedSessionDelivery,
  recoverPendingRestartContinuationDeliveries,
  scheduleRestartSentinelWake,
  settleQueuedSessionDelivery,
} = await import("./server-restart-sentinel.js");
const { resetGatewayWorkAdmission } = await import("../process/gateway-work-admission.js");
const actualRestartUpdateRun = await vi.importActual<
  typeof import("./server-restart-update-run.js")
>("./server-restart-update-run.js");

export {
  mocks,
  deliverQueuedSessionDelivery,
  recoverPendingRestartContinuationDeliveries,
  scheduleRestartSentinelWake,
  settleQueuedSessionDelivery,
  resetGatewayWorkAdmission,
  actualRestartUpdateRun,
};
export type { LoadedSessionEntry, RestartSentinel };
