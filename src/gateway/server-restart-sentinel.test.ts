import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../infra/update-run-ledger.js";
import { renderUpdateRunNotice, renderUpdateRunSummary } from "../infra/update-run-notice.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import {
  createGeneratedMediaDeliveryEntry,
  configureRestartSessionEventMocks,
  createRestartSentinelFixture as sentinelFixture,
  type RestartSentinelInProcessDispatchMock as InProcessDispatchMock,
  createRestartSentinelSessionFixture as sessionFixture,
  expectContinuationDispatchFields as assertContinuationDispatchFields,
  expectCapturedQueueContext,
  expectRestartSentinelTranscriptBroadcast,
  expectRecordFields,
  mockCallArg,
  lastMockCallArg,
  expectMockCallFields,
  type RestartSentinelSessionFixture as LoadedSessionEntry,
} from "./server-restart-sentinel.test-support.js";
import * as restartUpdateRun from "./server-restart-update-run.js";
import { createTranscriptUpdateBroadcastHandler } from "./server-session-events.js";
import { createSessionRowProjection } from "./session-row-projection.js";

type RestartSentinel = NonNullable<
  Awaited<ReturnType<typeof import("../infra/restart-sentinel.js").readRestartSentinel>>
>;

type RecordInboundSessionAndDispatchReplyParams = Parameters<
  typeof import("../channels/turn/lifecycle.js").dispatchAssembledChannelTurn
>[0] & {
  deliver: (payload: { text?: string; replyToId?: string | null }) => Promise<void>;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
};
type AdvanceSessionDeliveryAgentRunMock =
  typeof import("../infra/session-delivery-queue-storage.js").advanceSessionDeliveryAgentRun;
type MarkSessionDeliveryAttemptStartedMock =
  typeof import("../infra/session-delivery-queue-storage.js").markSessionDeliveryAttemptStarted;
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
type SendDurableMessageBatchCoreMock =
  typeof import("../channels/message/runtime.js").sendDurableMessageBatchCore;
type InspectDeliveryQueueReceiptMock =
  typeof import("../infra/delivery-queue-sqlite.js").inspectDeliveryQueueReceipt;

const mocks = vi.hoisted(() => {
  const state = {
    initialOutboundDelivery: null as Record<string, unknown> | null,
  };

  return {
    resolveSessionAgentId: vi.fn(() => "agent-from-key"),
    reserveSubagentCompletionControllerSource: vi.fn(),
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
    loadSessionEntryAsync:
      vi.fn<
        (
          sessionKey: string,
          options?: Parameters<
            typeof import("./session-entry-load.test-support.js").loadSessionEntryAsync
          >[1],
        ) => Promise<LoadedSessionEntry>
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
    loadSessionEntryInWorker:
      vi.fn<
        typeof import("./session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
      >(),
    resolveSessionTarget:
      vi.fn<
        typeof import("./session-utils-store-worker.js").resolveGatewaySessionStoreTargetInWorker
      >(),
    getRuntimeConfig: vi.fn<typeof import("../config/io.js").getRuntimeConfig>(),
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
    markSessionDeliveryAttemptStarted: vi.fn<MarkSessionDeliveryAttemptStartedMock>(async () => {}),
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
    sendDurableMessageBatchCore: vi.fn<SendDurableMessageBatchCoreMock>(),
    inspectDeliveryQueueReceipt: vi.fn<InspectDeliveryQueueReceiptMock>(),
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
  "../agents/subagents/announce/subagent-announce-controller-source.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../agents/subagents/announce/subagent-announce-controller-source.js")
    >()),
    reserveSubagentCompletionControllerSource: mocks.reserveSubagentCompletionControllerSource,
  }),
);

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
  mocks.advanceSessionDeliveryAgentRun.mockImplementation(actual.advanceSessionDeliveryAgentRun);
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

vi.mock("../cron/run-continuation-cleanup.js", () => ({
  removeCronRunContinuationSessionIfIdle: mocks.removeCronRunContinuationSessionIfIdle,
}));

vi.mock("../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));

vi.mock("./managed-image-attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-image-attachments.js")>()),
  createManagedOutgoingMediaBlocks: mocks.createManagedOutgoingMediaBlocks,
  attachManagedOutgoingMediaToMessage: mocks.attachManagedOutgoingMediaToMessage,
}));

vi.mock("../infra/delivery-queue-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/delivery-queue-sqlite.js")>();
  mocks.inspectDeliveryQueueReceipt.mockImplementation(actual.inspectDeliveryQueueReceipt);
  return { ...actual, inspectDeliveryQueueReceipt: mocks.inspectDeliveryQueueReceipt };
});

vi.mock("../config/sessions/main-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/main-session.js")>()),
  resolveSystemMainSessionTarget: mocks.resolveSystemMainSessionTarget,
}));

// mock-isolation: Restart fixtures publish their explicit config without loading a live config file.
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  getRuntimeConfigSnapshot: mocks.getRuntimeConfig,
}));

vi.mock("../channels/plugins/session-conversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/session-conversation.js")>()),
  resolveSessionThreadInfo: mocks.parseSessionThreadInfo,
}));

vi.mock("../channels/plugins/session-thread-info-loaded.js", () => ({
  resolveLoadedSessionThreadInfo: mocks.parseSessionThreadInfo,
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

vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

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
vi.mock("../infra/outbound/delivery-queue-recovery.js", () => ({
  drainPendingDeliveriesCore: mocks.drainPendingDeliveries,
  withActiveDeliveryClaim: mocks.withActiveDeliveryClaim,
}));

vi.mock("../infra/outbound/delivery-queue-preparation.js", () => ({
  withStableDeliveryPreparation: mocks.withStableDeliveryPreparation,
}));

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

vi.mock("../channels/message/runtime.js", async (importOriginal) => {
  type SendResult = Awaited<ReturnType<SendDurableMessageBatchCoreMock>>;
  mocks.sendDurableMessageBatchCore.mockImplementation(async (params) => {
    try {
      const results = await mocks.deliverOutboundPayloads(params);
      return { status: "sent", results } as SendResult;
    } catch (error) {
      return { status: "failed", error } as SendResult;
    }
  });
  return {
    ...(await importOriginal<typeof import("../channels/message/runtime.js")>()),
    sendDurableMessageBatchCore: mocks.sendDurableMessageBatchCore,
  };
});

vi.mock("./server-restart-update-run.js", async () => {
  const actual = await vi.importActual<typeof import("./server-restart-update-run.js")>(
    "./server-restart-update-run.js",
  );
  return { ...actual, finalizeRestartUpdateRun: vi.fn(actual.finalizeRestartUpdateRun) };
});

// mock-isolation: These producer tests use supplied rows; worker authority has its own boundary suite.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: mocks.loadSessionEntryInWorker,
  resolveGatewaySessionStoreTargetInWorker: mocks.resolveSessionTarget,
}));

// mock-isolation: Observe ordinary event adoption without starting a model turn.
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
const { subagentRuns } = await import("../agents/subagents/registry/subagent-registry-memory.js");
const { resetGatewayWorkAdmission } = await import("../process/gateway-work-admission.js");
const actualRestartUpdateRun = await vi.importActual<
  typeof import("./server-restart-update-run.js")
>("./server-restart-update-run.js");

const expectContinuationDispatchFields = assertContinuationDispatchFields.bind(
  null,
  mocks.recordInboundSessionAndDispatchReply,
);

function deliverGeneratedMedia(
  overrides: Parameters<typeof createGeneratedMediaDeliveryEntry>[0],
  stateDir?: string,
  resolveGatewayContext?: () => undefined,
) {
  return deliverQueuedSessionDelivery({
    deps: {} as never,
    queueContext:
      stateDir === undefined
        ? queueContext
        : captureOpenClawStateWorkerContext({
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }),
    ...(resolveGatewayContext ? { resolveGatewayContext } : {}),
    entry: createGeneratedMediaDeliveryEntry(overrides),
  });
}

function mockRestartContinuation(
  continuation: NonNullable<RestartSentinelPayload["continuation"]>,
  threadId?: string,
  revision?: number,
) {
  mocks.readRestartSentinel.mockResolvedValue({
    ...(revision === undefined ? {} : { version: 1, revision }),
    payload: {
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
      },
      ...(threadId === undefined ? {} : { threadId }),
      ts: 123,
      continuation,
    },
  } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
}

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let testState: OpenClawTestState;
let queueContext: OpenClawStateWorkerContext;

function wakeRestartSentinel() {
  return scheduleRestartSentinelWake({ scheduler, signal: scheduler.signal, deps: {} });
}

function expectQueueContext(stateDir = testState.stateDir) {
  return expectCapturedQueueContext(stateDir);
}

function setNoticeOwner(owner: string) {
  mocks.getRuntimeConfig.mockReturnValue({ commands: { ownerAllowFrom: [owner] } });
}

describe("scheduleRestartSentinelWake", () => {
  afterEach(async () => {
    await scheduler.stop();
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    await testState.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    clock = createGatewaySchedulerClock();
    scheduler = createTestGatewayScheduler(clock.clock);
    vi.mocked(restartUpdateRun.finalizeRestartUpdateRun)
      .mockReset()
      .mockImplementation(actualRestartUpdateRun.finalizeRestartUpdateRun);
    testState = await createOpenClawTestState({
      label: "gateway-restart-sentinel",
      layout: "state-only",
    });
    resetGatewayWorkAdmission();
    queueContext = captureOpenClawStateWorkerContext();
    vi.useRealTimers();
    mocks.setInitialOutboundDelivery(null);
    mocks.dispatchGatewayMethodInProcess.mockReset();
    mocks.dispatchGatewayMethodInProcess.mockResolvedValue({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: { status: "sent" },
      },
    });
    mocks.readRestartSentinel.mockReset();
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({
        kind: "restart",
        status: "ok",
        ts: 123,
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
        },
      }),
    );
    mocks.parseSessionThreadInfo.mockReset();
    mocks.parseSessionThreadInfo.mockReturnValue({ baseSessionKey: null, threadId: undefined });
    mocks.getRuntimeConfig.mockReset();
    mocks.getRuntimeConfig.mockReturnValue({ commands: { ownerAllowFrom: ["+15550002"] } });
    configureRestartSessionEventMocks(mocks);
    mocks.loadSessionEntryInWorker.mockReset().mockImplementation(async ({ key, agentId, env }) => {
      const loaded = await mocks.loadSessionEntryAsync(key, { agentId, env });
      return { ...loaded, agentId: loaded.agentId ?? agentId ?? "main" };
    });
    mocks.loadSessionEntryAsync.mockReset();
    mocks.loadSessionEntryAsync.mockImplementation(async (sessionKey: string) =>
      sessionFixture(
        sessionKey,
        { sessionId: sessionKey, updatedAt: 0 },
        { cfg: { commands: { ownerAllowFrom: ["+15550002"] } }, agentId: "main" },
      ),
    );
    mocks.deliveryContextFromSession.mockReset();
    mocks.deliveryContextFromSession.mockReturnValue(undefined);
    mocks.getChannelPlugin.mockReset();
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.resolveOutboundTarget.mockReset();
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true as const, to: "+15550002" });
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "whatsapp", messageId: "msg-1" }]);
    mocks.enqueueDeliveryOnce.mockReset();
    mocks.enqueueDeliveryOnce.mockImplementation(async (_payload, id) => ({ id, created: true }));
    mocks.findDeliveryIntentOwner.mockReset();
    mocks.findDeliveryIntentOwner.mockResolvedValue(null);
    mocks.withStableDeliveryPreparation.mockReset();
    mocks.withStableDeliveryPreparation.mockImplementation(
      async (params: {
        id: string;
        run: (owner: {
          current: () => Promise<Record<string, unknown>>;
          beforeFirstModifier: () => Promise<void>;
          markPrepared: () => Promise<void>;
          markPublished: () => void;
        }) => Promise<unknown>;
      }) => ({
        status: "claimed",
        value: await params.run({
          current: async () => ({ id: params.id }),
          beforeFirstModifier: async () => {},
          markPrepared: async () => {},
          markPublished: () => {},
        }),
      }),
    );
    mocks.loadPendingDelivery.mockReset();
    mocks.loadPendingDelivery.mockResolvedValue(null);
    mocks.appendAssistantMessageToSessionTranscript.mockReset();
    mocks.createManagedOutgoingMediaBlocks.mockReset();
    mocks.attachManagedOutgoingMediaToMessage.mockReset();
    mocks.finalizeUpdateRestartSentinelRunningVersion.mockReset();
    mocks.finalizeUpdateRestartSentinelRunningVersion.mockResolvedValue(null);
    mocks.clearSentinel.mockReset();
    mocks.clearSentinel.mockResolvedValue(true);
    mocks.resolveSystemMainSessionTarget.mockReset();
    mocks.resolveSystemMainSessionTarget.mockReturnValue({
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });
    mocks.recordInboundSessionAndDispatchReply.mockReset();
    mocks.recordInboundSessionAndDispatchReply.mockResolvedValue(undefined);
  });

  it("settles recovered deliveries before cron cleanup", async () => {
    await recoverPendingRestartContinuationDeliveries({ deps: {} as never, queueContext });

    const recovery = mocks.recoverPendingSessionDeliveries.mock.calls[0]?.[0];
    expect(recovery?.onSettled).toBe(settleQueuedSessionDelivery);
    const entry = {
      id: "correlated-completion-1",
      kind: "agentTurn",
      sessionKey: "agent:main:main",
      message: "retained completion",
      messageId: "completion-1",
      enqueuedAt: 1,
      retryCount: 0,
    } as const;
    await recovery?.onSettled?.(entry, "recovered", queueContext);

    expect(mocks.removeCronRunContinuationSessionIfIdle).toHaveBeenCalledWith(
      entry.sessionKey,
      entry.id,
      queueContext,
    );
    expect(mocks.settleCorrelatedSubagentDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeCronRunContinuationSessionIfIdle.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("records a non-owner update without delivery or a diagnostic wake", async () => {
    const sessionKey = "agent:main:whatsapp:direct:+15550002";
    const run = createUpdateRun({ trigger: "control-ui", origin: { sessionKey } });
    const session = await mocks.loadSessionEntryAsync(sessionKey);
    mocks.getRuntimeConfig.mockReturnValue({ commands: { ownerAllowFrom: ["telegram:12345"] } });
    mocks.loadSessionEntryAsync.mockResolvedValue({
      ...session,
      cfg: { commands: { ownerAllowFrom: ["telegram:12345"] } },
    });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({
        kind: "update",
        status: "ok",
        ts: 123,
        sessionKey,
        deliveryContext: { channel: "whatsapp", to: "+15550002", accountId: "acct-2" },
        stats: { mode: "npm", runId: run.runId },
      }),
    );

    await wakeRestartSentinel();

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.clearSentinel).toHaveBeenCalledWith(123, queueContext.environment);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("target is not a current command owner"),
      expect.objectContaining({ runId: run.runId }),
    );
    expect(getUpdateRun(run.runId)?.verification.noticeDelivered).toBe(false);
  });

  it.each([
    { terminal: false, channel: "webchat" },
    { terminal: true, channel: "telegram" },
  ])(
    "uses the durable update outcome on boot ($channel, already terminal: $terminal)",
    async ({ terminal, channel }) => {
      const record = createUpdateRun({
        trigger: "api",
        before: { version: "2026.9.1" },
        target: { version: resolveRuntimeServiceVersion() },
      });
      const existing = terminal
        ? finishUpdateRun(record.runId, { status: "failed", reason: "post-update-plugins" })
        : record;
      mocks.deliveryContextFromSession.mockReturnValue({
        channel,
        ...(channel === "telegram" ? { to: "chat-123" } : {}),
      });
      mocks.appendAssistantMessageToSessionTranscript.mockResolvedValue({
        ok: true,
        target: {
          agentId: "main",
          sessionId: "main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
        messageId: "update-notice",
      });
      mocks.readRestartSentinel.mockResolvedValue(
        sentinelFixture({
          kind: "update",
          status: "ok",
          ts: 123,
          sessionKey: "agent:main:main",
          stats: { runId: record.runId },
          doctorHint: "Run openclaw --profile work doctor --non-interactive.",
        }),
      );

      await wakeRestartSentinel();

      const result = getUpdateRun(record.runId)!;
      expect(result.status).toBe(terminal ? "failed" : "succeeded");
      expect(result.verification).toMatchObject(
        terminal
          ? { ...existing.verification, noticeDelivered: true }
          : {
              booted: true,
              serviceRunning: true,
              runningVersion: resolveRuntimeServiceVersion(),
              noticeDelivered: true,
              doctorHint: "Run openclaw --profile work doctor --non-interactive.",
            },
      );
      if (terminal) {
        expect(result.verification.booted).toBeUndefined();
        expect(result.verification.doctorHint).toBeUndefined();
      }
      if (terminal) {
        expect(result.finishedAtMs).toBe(existing.finishedAtMs);
      }
      const message = renderUpdateRunSummary(result);
      if (channel === "webchat") {
        expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
          expect.objectContaining({ text: message }),
        );
        expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
      } else {
        expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
          expect.objectContaining({ payloads: [{ text: message }] }),
        );
      }
    },
  );

  it.each([false, true])(
    "bounds pending notice retries while preserving CLI run ownership (%s)",
    async (cliFinished) => {
      // Exercise real SQLite at initial/expiry/finish boundaries, not 900
      // identical observations. Slow forked reads can outlive a fake-timer test.
      const finalize = actualRestartUpdateRun.finalizeRestartUpdateRun;
      let observedRun: Awaited<ReturnType<typeof finalize>>;
      const finalizeSpy = vi
        .mocked(restartUpdateRun.finalizeRestartUpdateRun)
        .mockImplementation(async (payload, expired) => {
          if (!observedRun || expired) {
            observedRun = await finalize(payload, expired);
          }
          return observedRun;
        });
      const record = createUpdateRun({
        trigger: "api",
        target: { version: resolveRuntimeServiceVersion() },
      });
      recordUpdateRunPhase(record.runId, "restarting");
      mocks.deliveryContextFromSession.mockReturnValue({ channel: "webchat" });
      mocks.appendAssistantMessageToSessionTranscript.mockResolvedValue({
        ok: true,
        target: {
          agentId: "main",
          sessionId: "main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
        messageId: "update-notice",
      });
      mocks.readRestartSentinel.mockResolvedValue(
        sentinelFixture({
          kind: "update",
          status: "skipped",
          ts: 123,
          sessionKey: "agent:main:main",
          stats: {
            runId: record.runId,
            handoffId: "managed-update-handoff",
            reason: "restart-health-pending",
          },
        }),
      );

      await wakeRestartSentinel();
      expect(getUpdateRun(record.runId)?.status).toBe("running");
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "🔁 Checking that OpenClaw is ready…",
        }),
      );
      if (cliFinished) {
        observedRun = finishUpdateRun(record.runId, {
          status: "succeeded",
          after: { version: resolveRuntimeServiceVersion() },
        });
      }
      for (let attempt = 0; attempt < 899; attempt += 1) {
        await clock.advanceBy(2_000);
      }
      expect(mocks.clearSentinel).not.toHaveBeenCalled();
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
      await clock.advanceBy(2_000);

      const result = getUpdateRun(record.runId)!;
      expect(result.status).toBe(cliFinished ? "succeeded" : "running");
      expect(result.reason).toBeNull();
      if (!cliFinished) {
        expect(result.finishedAtMs).toBeNull();
        expect(result.verification.noticeDelivered).toBeUndefined();
        expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
        expect(mocks.clearSentinel).not.toHaveBeenCalled();
        const readsAtExpiry = mocks.readRestartSentinel.mock.calls.length;
        await clock.advanceBy(1_800_000);
        expect(mocks.readRestartSentinel).toHaveBeenCalledTimes(readsAtExpiry);
        observedRun = finishUpdateRun(record.runId, {
          status: "succeeded",
          after: { version: resolveRuntimeServiceVersion() },
        });
        mocks.readRestartSentinel.mockResolvedValue(
          sentinelFixture(
            {
              kind: "update",
              status: "ok",
              ts: 124,
              sessionKey: "agent:main:main",
              stats: { runId: record.runId, handoffId: "managed-update-handoff" },
            },
            124,
          ),
        );
        await wakeRestartSentinel();
      }
      const completed = getUpdateRun(record.runId)!;
      expect(completed.status).toBe("succeeded");
      expect(completed.verification.noticeDelivered).toBe(true);
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          text: renderUpdateRunSummary(completed),
          idempotencyKey: `update-run-finished:${record.runId}`,
        }),
      );
      expect(mocks.clearSentinel).toHaveBeenCalledOnce();
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(2);
      const sentinelReads = mocks.readRestartSentinel.mock.calls.length;
      await clock.advanceBy(1_800_000);
      expect(mocks.readRestartSentinel).toHaveBeenCalledTimes(sentinelReads);
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(2);
      expect(mocks.clearSentinel).toHaveBeenCalledOnce();
      finalizeSpy.mockRestore();
    },
  );

  it("appends and broadcasts the durable internal update outcome only once", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "internal-update-session";
    const storePath = testState.statePath("agents", "main", "sessions", "sessions.json");
    const entry = { sessionId, updatedAt: 1, lifecycleRevision: "update-lifecycle" };
    await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, entry);
    const originalMerge = mocks.mergeDeliveryContext.getMockImplementation()!;
    const delivery = await vi.importActual<typeof import("../utils/delivery-context.shared.js")>(
      "../utils/delivery-context.shared.js",
    );
    const deliveryRead = await vi.importActual<typeof import("../utils/delivery-context.read.js")>(
      "../utils/delivery-context.read.js",
    );
    const sessionWorker = await vi.importActual<typeof import("./session-utils-store-worker.js")>(
      "./session-utils-store-worker.js",
    );
    mocks.loadSessionEntryInWorker.mockImplementation(
      sessionWorker.loadGatewaySessionEntryReadOnlyInWorker,
    );
    mocks.loadSessionEntryAsync.mockImplementation((key, options) =>
      sessionWorker.loadGatewaySessionEntryReadOnlyInWorker({
        cfg: mocks.getRuntimeConfig(),
        key,
        ...options,
      }),
    );
    mocks.deliveryContextFromSession.mockImplementation(deliveryRead.deliveryContextFromSession);
    mocks.mergeDeliveryContext.mockImplementation(delivery.mergeDeliveryContext);
    const updateRun = createUpdateRun({ trigger: "api", origin: { sessionKey } });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({
        kind: "update",
        status: "ok",
        ts: 123,
        sessionKey,
        stats: { mode: "npm", runId: updateRun.runId },
      }),
    );
    const transcript = await vi.importActual<typeof import("../config/sessions/transcript.js")>(
      "../config/sessions/transcript.js",
    );
    mocks.appendAssistantMessageToSessionTranscript.mockImplementation(
      transcript.appendAssistantMessageToSessionTranscript,
    );
    const broadcastToConnIds = vi.fn();
    const subscribers = new Set(["control-ui-connection"]);
    const rowProjection = await createSessionRowProjection({
      cfg: { agents: { entries: { main: {} } }, session: { store: storePath } },
    });
    expect(rowProjection.capture({ agentId: "main", key: sessionKey })?.entry).toMatchObject({
      sessionId,
      lifecycleRevision: entry.lifecycleRevision,
    });
    const publish = createTranscriptUpdateBroadcastHandler({
      getSessionRowProjection: () => rowProjection,
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => subscribers },
      sessionMessageSubscribers: { get: () => subscribers },
    });
    const publications: ReturnType<typeof publish>[] = [];
    const publicationErrors: unknown[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
      if (update.target?.sessionId === sessionId) {
        publications.push(
          publish(update).catch((error: unknown) => {
            publicationErrors.push(error);
          }),
        );
      }
    });
    try {
      const { createUpdateRunNotifier } = await import("./update-run-notice.runtime.js");
      const notify = await createUpdateRunNotifier(updateRun, () => ({}), {});
      expect.soft(await notify(updateRun, "ack")).toEqual({ delivered: true, owned: true });
      expect
        .soft(getUpdateRun(updateRun.runId)?.steps)
        .toContainEqual(expect.objectContaining({ step: "notice:ack", status: "completed" }));
      const ackEvents = await loadTranscriptEvents({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
      });
      expect.soft(ackEvents).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "assistant",
            idempotencyKey: `update-run-ack:${updateRun.runId}`,
            content: [{ type: "text", text: renderUpdateRunNotice(updateRun, "ack") }],
          }),
        }),
      );
      finishUpdateRun(updateRun.runId, { status: "succeeded" });
      await wakeRestartSentinel();
      await wakeRestartSentinel();
      await Promise.all(publications);
      expect(publicationErrors).toEqual([]);
      const finishedRun = getUpdateRun(updateRun.runId)!;
      const report = renderUpdateRunSummary(finishedRun);
      expect.soft(finishedRun?.verification.noticeDelivered).toBe(true);
      expect.soft(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
      expect.soft(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
      expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          sessionKey,
          expectedSessionId: sessionId,
          expectedLifecycleRevision: entry.lifecycleRevision,
          storePath,
          text: report,
          idempotencyKey: `update-run-finished:${updateRun.runId}`,
        }),
      );
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
      });
      expect(events.filter((event) => asOptionalRecord(event)?.type === "message")).toHaveLength(2);
      expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
      expectRestartSentinelTranscriptBroadcast(broadcastToConnIds, {
        sessionKey,
        report,
        subscribers,
      });
      expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
      expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
      expect(mocks.logWarn).not.toHaveBeenCalled();
    } finally {
      mocks.mergeDeliveryContext.mockImplementation(originalMerge);
      unsubscribe();
      await Promise.allSettled(publications);
      rowProjection.dispose();
    }
  });

  it("wakes the internal session when the update notice append throws", async () => {
    mocks.deliveryContextFromSession.mockReturnValue({ channel: "webchat" });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({ kind: "update", status: "error", ts: 123, sessionKey: "agent:main:main" }),
    );
    mocks.appendAssistantMessageToSessionTranscript.mockRejectedValue(new Error("append failed"));

    await wakeRestartSentinel();

    expect(mocks.logWarn).toHaveBeenCalledWith(
      "restart summary: internal restart notice append failed; falling back to wake: append failed",
      { sessionKey: "agent:main:main" },
    );
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
      "restart message",
      expect.objectContaining({ sessionKey: "agent:main:main", source: "restart" }),
    );

    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
  });

  it("persists every downstream intent before consuming the loaded revision", async () => {
    await wakeRestartSentinel();

    expect(mocks.clearSentinel).toHaveBeenCalledWith(123, queueContext.environment);
    const clearOrder = mocks.clearSentinel.mock.invocationCallOrder[0] ?? 0;
    expect(mocks.enqueueSessionDelivery.mock.invocationCallOrder[0]).toBeLessThan(clearOrder);
    expect(mocks.enqueueDeliveryOnce.mock.invocationCallOrder[0]).toBeLessThan(clearOrder);
    expect(clearOrder).toBeLessThan(mocks.enqueueSessionEvent.mock.invocationCallOrder[0] ?? 0);
    expect(clearOrder).toBeLessThan(mocks.deliverOutboundPayloads.mock.invocationCallOrder[0] ?? 0);
  });

  it("stops delivery when guarded sentinel consumption fails", async () => {
    mocks.clearSentinel.mockRejectedValueOnce(new Error("database locked"));

    await wakeRestartSentinel();

    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledOnce();
    expect(mocks.enqueueDeliveryOnce).toHaveBeenCalledOnce();
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("startup task failed", {
      source: "restart-sentinel",
      sessionKey: "agent:main:main",
      reason: "database locked",
    });
  });

  it("does not resend a restart notice whose stable queue id is already owned", async () => {
    mocks.withStableDeliveryPreparation.mockResolvedValueOnce({ status: "existing" });
    mocks.findDeliveryIntentOwner.mockResolvedValueOnce({
      namespace: "prepared",
      status: "pending",
    });

    await wakeRestartSentinel();

    expect(mocks.clearSentinel).toHaveBeenCalledWith(123, queueContext.environment);
    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.ackDelivery).not.toHaveBeenCalled();
    expect(mocks.failDelivery).not.toHaveBeenCalled();
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "restart summary: durable restart notice already owned",
      { sessionKey: "agent:main:main" },
    );
  });

  it("queues the restart wake before a system-event continuation", async () => {
    mocks.readRestartSentinel.mockResolvedValueOnce(
      sentinelFixture({
        kind: "restart",
        status: "ok",
        ts: 99,
        sessionKey: "agent:main:main",
        continuation: { kind: "systemEvent", text: "continue" },
      }),
    );

    await wakeRestartSentinel();

    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueSessionDelivery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        text: "restart message",
        idempotencyKey: "restart-sentinel-wake:agent:main:main:123",
        completionRetention: "permanent",
      }),
      expectQueueContext(),
    );
    expect(mocks.enqueueSessionDelivery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: "continue",
        idempotencyKey: "restart-sentinel:agent:main:main:systemEvent:123",
        completionRetention: "permanent",
      }),
      expectQueueContext(),
    );
    expect(mocks.enqueueSessionEvent.mock.calls.map((call) => call[0])).toEqual([
      "restart message",
      "continue",
    ]);
  });

  it("queues a failed outbound notice for durable recovery without dropping the agent wake", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("platform outcome unknown"));
    mocks.loadPendingDelivery
      .mockResolvedValueOnce({
        id: "restart-sentinel-notice:agent:main:main:123",
        retryCount: 1,
        lastError: "platform outcome unknown",
      } as never)
      .mockResolvedValue(null);

    await wakeRestartSentinel();

    expect(mocks.enqueueDeliveryOnce).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    expectMockCallFields(mocks.deliverOutboundPayloads, {
      skipQueue: true,
      deliveryQueueId: "restart-sentinel-notice:agent:main:main:123",
    });
    expect(mocks.ackDelivery).not.toHaveBeenCalled();
    expect(mocks.failDelivery.mock.calls[0]?.slice(0, 2)).toEqual([
      "restart-sentinel-notice:agent:main:main:123",
      "platform outcome unknown",
    ]);
    expect(mocks.drainPendingDeliveries).toHaveBeenCalledOnce();
    expectRecordFields(mockCallArg(mocks.drainPendingDeliveries), {
      drainKey: "restart-recovery:restart-sentinel-notice:agent:main:main:123",
      deliver: expect.any(Function),
    });
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "restart summary: outbound delivery failed; queued for recovery: Error: platform outcome unknown",
      {
        channel: "whatsapp",
        to: "+15550002",
        sessionKey: "agent:main:main",
      },
    );
  });

  it("runs agentTurn continuation internally after the restart notice without routed final delivery", async () => {
    mockRestartContinuation(
      {
        kind: "agentTurn",
        message: "Reply with exactly: Yay! I did it!",
      },
      "thread-42",
    );
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(async (params) => {
      await params.turnAdoptionLifecycle?.onAdopted();
      await params.deliver({
        text: "done",
        replyToId: "restart-sentinel:agent:main:main:agentTurn:123",
      });
    });

    await wakeRestartSentinel();

    expectMockCallFields(mocks.enqueueDeliveryOnce, {
      payloads: [{ text: "restart message" }],
      threadId: "thread-42",
    });
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(1);
    expect(mocks.markSessionDeliveryAttemptStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), kind: "agentTurn" }),
      expectQueueContext(),
    );
    expectContinuationDispatchFields(
      {
        channel: "whatsapp",
        accountId: "acct-2",
        routeSessionKey: "agent:main:main",
        replyOptions: expect.objectContaining({ sourceReplyDeliveryMode: "message_tool_only" }),
      },
      {
        Body: "Reply with exactly: Yay! I did it!",
        BodyForAgent: "Reply with exactly: Yay! I did it!",
        BodyForCommands: "",
        CommandBody: "",
        CommandAuthorized: true,
        GatewayClientScopes: ["operator.admin"],
        GatewayClientCaps: [],
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "whatsapp",
          sourceTool: "restart-sentinel",
        },
        SessionKey: "agent:main:main",
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "whatsapp",
        OriginatingTo: "+15550002",
        ExplicitDeliverRoute: false,
        MessageThreadId: "thread-42",
      },
    );
    const deliveredContinuationReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === "done") === true);
    expect(deliveredContinuationReply).toBe(false);
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
  });

  async function enqueueGeneratedMedia(
    overrides: Partial<Parameters<typeof createGeneratedMediaDeliveryEntry>[0]> & {
      messageId: string;
    },
  ) {
    const {
      id: _id,
      enqueuedAt: _enqueuedAt,
      retryCount: _retryCount,
      ...payload
    } = createGeneratedMediaDeliveryEntry({
      id: "unused",
      idempotencyKey: overrides.messageId,
      ...overrides,
    });
    const id = await mocks.enqueueSessionDelivery(payload, queueContext);
    const entry = await mocks.loadPendingSessionDelivery(id, queueContext);
    if (entry?.kind !== "agentTurn") {
      throw new Error("expected queued generated media");
    }
    return entry as Parameters<typeof createGeneratedMediaDeliveryEntry>[0];
  }

  async function deliverGeneratedMediaThenCompletion(
    entry: Parameters<typeof createGeneratedMediaDeliveryEntry>[0],
  ) {
    await expect(deliverGeneratedMedia(entry)).rejects.toThrow("its completion turn follows");
    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
    const advanced = await mocks.loadPendingSessionDelivery(entry.id, queueContext);
    expect(advanced).toMatchObject({
      expectedMediaUrls: [],
      agentRunAttempt: (entry.agentRunAttempt ?? 0) + 1,
    });
    await deliverGeneratedMedia(advanced);
  }

  function lastAgentDispatch() {
    const call = mocks.dispatchGatewayMethodInProcess.mock.calls.at(-1);
    expect(call?.[0]).toBe("agent");
    return { request: call?.[1] as Record<string, unknown>, options: call?.[2] };
  }

  it("sends generated media from the host before one ordinary completion turn", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-1:agent-loop",
      route: { channel: "discord", to: "channel:123", accountId: "default", chatType: "channel" },
      sourceReplyDeliveryMode: "message_tool_only",
      expectedMediaUrls: ["/tmp/proof.png"],
    });

    await deliverGeneratedMediaThenCompletion(entry);

    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(1);
    expect(mocks.sendDurableMessageBatchCore.mock.calls[0]?.[0]).toMatchObject({
      channel: "discord",
      to: "channel:123",
      accountId: "default",
      payloads: [{ mediaUrls: ["/tmp/proof.png"] }],
      durability: "required",
      deliveryIntentId: `generated-media-delivery:v1:${entry.id}`,
      reusePendingDeliveryIntent: true,
    });
    const { request, options } = lastAgentDispatch();
    // No restart-safe tool filter, no disabled message tool, no host media
    // constraint: the completion turn has the requester's normal toolset.
    expect(request).toEqual({
      sessionKey: "agent:main:main",
      message: expect.stringContaining("[Generated media delivered]"),
      deliver: true,
      bestEffortDeliver: false,
      channel: "discord",
      accountId: "default",
      to: "channel:123",
      threadId: undefined,
      inputProvenance: entry.inputProvenance,
      sourceReplyDeliveryMode: "message_tool_only",
      idempotencyKey: "image:task-1:agent-loop:attempt:1",
    });
    expect(String(request.message)).toContain("Do not send these files again.");
    expect(String(request.message).endsWith("generated image ready")).toBe(true);
    expect(options).toEqual({
      expectFinal: true,
      forceSyntheticClient: true,
      runtimeContextFragments: undefined,
      onAccepted: expect.any(Function),
    });
    expect(mocks.sendDurableMessageBatchCore.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispatchGatewayMethodInProcess.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("drains a media row rearmed by the retired agent-turn design through host delivery", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-upgrade:agent-loop",
      message: "Deliver the caption and every structured generated attachment.",
      expectedMediaUrls: ["/tmp/missing.png"],
      suppressTextDelivery: true,
    });
    await mocks.advanceSessionDeliveryAgentRun(entry.id, undefined, queueContext);
    const rearmed = await mocks.loadPendingSessionDelivery(entry.id, queueContext);
    expect(rearmed).toMatchObject({ agentRunAttempt: 1, suppressTextDelivery: true });

    await deliverGeneratedMediaThenCompletion(rearmed);

    expect(mocks.sendDurableMessageBatchCore.mock.calls[0]?.[0]).toMatchObject({
      payloads: [{ mediaUrls: ["/tmp/missing.png"] }],
    });
    const { request } = lastAgentDispatch();
    // The retired instruction now follows a host notice that the files were sent.
    expect(String(request.message)).toMatch(
      /^[\s\S]*Do not send these files again\.[\s\S]*Deliver the caption/u,
    );
    expect(request).not.toHaveProperty("disableMessageTool");
    expect(request).not.toHaveProperty("forceRestartSafeTools");
  });

  it("keeps a rearmed internal media row clear of the retired transcript identity", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-internal-upgrade:agent-loop",
      route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
      expectedMediaUrls: ["/tmp/two.png"],
    });
    // An older release already wrote one.png under the base key, then rearmed.
    await mocks.advanceSessionDeliveryAgentRun(entry.id, undefined, queueContext);

    await deliverGeneratedMediaThenCompletion(
      await mocks.loadPendingSessionDelivery(entry.id, queueContext),
    );

    const keys = mocks.appendAssistantMessageToSessionTranscript.mock.calls.map(
      ([params]) => params.idempotencyKey,
    );
    expect(keys).toEqual([
      "image:task-internal-upgrade:agent-loop:attempt:1:generated-media-host-transcript",
    ]);
    expect(keys).not.toContain("image:task-internal-upgrade:agent-loop:generated-media-transcript");
  });

  it("does not resend media after a crash between the send and the completion turn", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-crash:agent-loop",
      expectedMediaUrls: ["/tmp/proof.png"],
    });
    const queueStorageActual = await vi.importActual<
      typeof import("../infra/session-delivery-queue-storage.js")
    >("../infra/session-delivery-queue-storage.js");
    mocks.markSessionDeliveryAttemptStarted.mockImplementationOnce(
      queueStorageActual.markSessionDeliveryAttemptStarted,
    );
    mocks.advanceSessionDeliveryAgentRun.mockRejectedValueOnce(new Error("crash after send"));

    await expect(deliverGeneratedMedia(entry)).rejects.toThrow("crash after send");
    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
    expect(await mocks.loadPendingSessionDelivery(entry.id, queueContext)).toMatchObject({
      deliveryStartedAt: expect.any(Number),
    });

    // The fenced replay never sends; its completed outbound receipt proves the first send.
    mocks.inspectDeliveryQueueReceipt.mockResolvedValueOnce({
      status: "completed",
      pendingEntry: null,
    } as never);
    await deliverGeneratedMediaThenCompletion(
      await mocks.loadPendingSessionDelivery(entry.id, queueContext),
    );

    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
  });

  it("dead-letters a host media send that may have reached the chat", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-ambiguous:agent-loop",
      expectedMediaUrls: ["/tmp/proof.png"],
    });
    mocks.sendDurableMessageBatchCore.mockResolvedValueOnce({
      status: "partial_failed",
      results: [],
      error: new Error("lost platform acknowledgement"),
    } as never);

    await expect(deliverGeneratedMedia(entry)).rejects.toThrow(
      "dead-lettered after ambiguous side effects",
    );

    expect(mocks.markSessionDeliverySettlement).toHaveBeenCalledWith(
      expect.objectContaining({ id: entry.id }),
      "moved-to-failed",
      expectQueueContext(),
    );
    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });

  it("dead-letters a media send whose outbound owner failed terminally", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-outbound-failed:agent-loop",
      expectedMediaUrls: ["/tmp/proof.png"],
    });
    mocks.sendDurableMessageBatchCore.mockResolvedValueOnce({
      status: "suppressed",
      reason: "no_visible_result",
    } as never);
    mocks.inspectDeliveryQueueReceipt.mockResolvedValueOnce({
      status: "failed",
      pendingEntry: null,
    } as never);

    await expect(deliverGeneratedMedia(entry)).rejects.toThrow(
      "dead-lettered after ambiguous side effects",
    );

    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });

  it("waits for outbound recovery that still owns the media send", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-outbound-owned:agent-loop",
      expectedMediaUrls: ["/tmp/proof.png"],
    });
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("platform timeout"));
    mocks.inspectDeliveryQueueReceipt.mockResolvedValueOnce({
      status: "pending",
      pendingEntry: null,
    } as never);

    await expect(deliverGeneratedMedia(entry)).rejects.toThrow(
      "still owned by outbound delivery recovery",
    );

    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith(entry.id, 1_000, expectQueueContext());
    expect(mocks.markSessionDeliverySettlement).not.toHaveBeenCalled();
    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });

  it("retries a host media send proven not to reach the chat", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-not-sent:agent-loop",
      expectedMediaUrls: ["/tmp/proof.png"],
    });
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("channel offline"));

    await expect(deliverGeneratedMedia(entry)).rejects.toMatchObject({
      name: "SessionDeliverySafeRetryError",
      message: "queued generated-media send did not reach the chat",
    });

    expect(mocks.markSessionDeliverySettlement).not.toHaveBeenCalled();
    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });

  it("runs a failed generation as one ordinary completion turn without a media send", async () => {
    const entry = await enqueueGeneratedMedia({ messageId: "image:task-failed:agent-loop" });

    await deliverGeneratedMedia(entry);

    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    const { request } = lastAgentDispatch();
    expect(request).toEqual({
      sessionKey: "agent:main:main",
      message: "generated image ready",
      deliver: true,
      bestEffortDeliver: false,
      channel: "discord",
      accountId: undefined,
      to: "channel:123",
      threadId: undefined,
      inputProvenance: entry.inputProvenance,
      sourceReplyDeliveryMode: "automatic",
      idempotencyKey: "image:task-failed:agent-loop",
    });
  });

  it("settles delivered media when only its completion turn is refused", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-refused-turn:agent-loop",
      expectedMediaUrls: ["/tmp/proof.png"],
      expectedMediaAttachments: { "/tmp/proof.png": { type: "image", path: "/tmp/proof.png" } },
    });
    mocks.dispatchGatewayMethodInProcess.mockImplementationOnce(async () => {
      const { SessionDeliveryDeadLetteredError } =
        await import("../infra/session-delivery-queue.records.js");
      throw new SessionDeliveryDeadLetteredError("requester session changed");
    });

    await deliverGeneratedMediaThenCompletion(entry);

    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledTimes(1);
    expect(mocks.markSessionDeliverySettlement).not.toHaveBeenCalledWith(
      expect.anything(),
      "moved-to-failed",
      expect.anything(),
    );
  });

  it("dead-letters a refused completion turn that carries no delivered media", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-refused-failure:agent-loop",
    });
    mocks.dispatchGatewayMethodInProcess.mockImplementationOnce(async () => {
      const { SessionDeliveryDeadLetteredError } =
        await import("../infra/session-delivery-queue.records.js");
      throw new SessionDeliveryDeadLetteredError("requester session changed");
    });

    await expect(deliverGeneratedMedia(entry)).rejects.toThrow("requester session changed");
    expect(mocks.markSessionDeliverySettlement).toHaveBeenCalledWith(
      expect.objectContaining({ id: entry.id }),
      "moved-to-failed",
      expectQueueContext(),
    );
  });

  it("keeps a completion-turn rejection before acceptance retryable", async () => {
    mocks.dispatchGatewayMethodInProcess.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-pre-accept",
        messageId: "image:task-pre-accept:agent-loop",
      }),
    ).rejects.toThrow("failed before gateway acceptance");

    expect(mocks.markSessionDeliveryAttemptStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-delivery-media-pre-accept" }),
      expectQueueContext(),
    );
    expect(mocks.markSessionDeliverySettlement).not.toHaveBeenCalled();
  });

  it("dead-letters an interrupted completion attempt instead of replaying it", async () => {
    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-interrupted",
        messageId: "image:task-interrupted:agent-loop",
        deliveryStartedAt: 1,
      }),
    ).rejects.toThrow("dead-lettered after an interrupted unproven attempt");

    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });

  it("never resends a started host media send whose receipt is gone", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-expired-receipt:agent-loop",
      expectedMediaUrls: ["/tmp/proof.png"],
    });

    await expect(deliverGeneratedMedia({ ...entry, deliveryStartedAt: 1 })).rejects.toThrow(
      "dead-lettered after ambiguous side effects",
    );

    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });

  it("authorizes the completion turn for an active cron continuation", async () => {
    mocks.loadSessionEntryAsync.mockResolvedValue(
      sessionFixture("agent:main:cron:daily-media:run:run-123", {
        sessionId: "cron-run-session",
        cronRunContinuation: {
          lifecycleRevision: "revision-1",
          phase: "ready",
          basePersisted: true,
        },
        updatedAt: 1,
      }),
    );

    await deliverGeneratedMedia({
      id: "session-delivery-cron-media",
      sessionKey: "agent:main:cron:daily-media:run:run-123",
      messageId: "image:cron-task:agent-loop",
    });

    const { request, options } = lastAgentDispatch();
    expect(request).toMatchObject({
      sessionKey: "agent:main:cron:daily-media:run:run-123",
      sessionId: "cron-run-session",
    });
    expect(options).toMatchObject({ allowSyntheticCronRunContinuation: true });
  });

  it("awaits completion source custody and retires it when Gateway admission fails", async () => {
    const { reserveSessionControllerSource, retireSessionControllerInput } =
      await import("../sessions/session-controller.mailbox.js");
    const { captureSessionTarget } = await import("../sessions/session-controller.lifecycle.js");
    const input = reserveSessionControllerSource("agent:main:main", {
      target: captureSessionTarget({
        storeScope: "/tmp/sessions.json",
        sessionKey: "agent:main:main",
        agentId: "main",
        incarnation: "agent:main:main",
      }),
      policy: { mode: "followup" },
    });
    const reserved = createDeferred<typeof input>();
    const entered = createDeferred();
    const deadlineAt = Date.now() + 60_000;
    const completionOwner: SubagentRunRecord = {
      runId: "run-reserved-completion",
      childSessionKey: "agent:main:subagent:reserved-completion",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "generate media",
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "terminal", startedAt: 2, endedAt: 3, outcome: { status: "ok" } },
      delivery: {
        status: "in_progress",
        queueId: "session-delivery-reserved-completion",
        generation: 0,
        deadlineAt,
      },
    };
    mocks.reserveSubagentCompletionControllerSource.mockImplementationOnce(() => {
      entered.resolve();
      return reserved.promise;
    });
    mocks.dispatchGatewayMethodInProcess.mockRejectedValueOnce(new Error("gateway unavailable"));
    subagentRuns.set(completionOwner.runId, completionOwner);
    try {
      const delivery = expect(
        deliverGeneratedMedia({
          id: "session-delivery-reserved-completion",
          messageId: "image:reserved-completion:agent-loop",
          expectedMediaUrls: [],
          owner: {
            kind: "subagent_completion",
            runId: completionOwner.runId,
            taskId: completionOwner.runId,
            generation: 0,
            deadlineAt,
          },
        }),
      ).rejects.toThrow("failed before gateway acceptance");
      await awaitGateBeforeSettlement(
        entered.promise,
        delivery,
        "Completion delivery settled before reserving controller custody",
      );
      expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
      reserved.resolve(input);
      await delivery;
      expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
        "agent",
        expect.any(Object),
        expect.objectContaining({ controllerInput: input }),
      );
      expect(input.retirementRequested).toBe(true);
      await input.settlement.promise;
    } finally {
      reserved.resolve(input);
      retireSessionControllerInput(input);
      subagentRuns.delete(completionOwner.runId);
    }
  });

  it("persists internal generated media in the owning transcript before the completion turn", async () => {
    const attachment = {
      type: "audio" as const,
      mediaUrl: "/tmp/proof.mp3",
      mimeType: "audio/mpeg",
    };
    const entry = await enqueueGeneratedMedia({
      messageId: "audio:task-internal:agent-loop",
      route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
      expectedMediaUrls: [attachment.mediaUrl],
      expectedMediaAttachments: {
        [attachment.mediaUrl]: {
          type: attachment.type,
          path: attachment.mediaUrl,
          mimeType: attachment.mimeType,
        },
      },
    });

    await deliverGeneratedMediaThenCompletion(entry);

    expect(mocks.sendDurableMessageBatchCore).not.toHaveBeenCalled();
    expect(mocks.createManagedOutgoingMediaBlocks).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      agentId: "main",
      items: [{ url: attachment.mediaUrl, mimeType: attachment.mimeType, trustedLocal: true }],
      stateDir: testState.stateDir,
      localRoots: [testState.statePath("media")],
    });
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [],
        displayContent: [expect.objectContaining({ type: attachment.type })],
        idempotencyKey: "audio:task-internal:agent-loop:generated-media-host-transcript",
      }),
    );
    expect(mocks.attachManagedOutgoingMediaToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "generated-media-transcript" }),
    );
    expect(lastAgentDispatch().request).toMatchObject({
      deliver: false,
      sourceReplyDeliveryMode: "automatic",
    });
    expect(
      mocks.appendAssistantMessageToSessionTranscript.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.dispatchGatewayMethodInProcess.mock.invocationCallOrder[0] ?? 0);
  });

  it("reuses prepared internal media when a transcript write is replayed", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-internal-replay:agent-loop",
      route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
      expectedMediaUrls: ["/tmp/proof.png"],
    });
    mocks.attachManagedOutgoingMediaToMessage.mockRejectedValueOnce(
      new Error("synthetic crash after transcript append"),
    );

    await expect(deliverGeneratedMedia(entry)).rejects.toThrow(
      "synthetic crash after transcript append",
    );
    await deliverGeneratedMediaThenCompletion(
      await mocks.loadPendingSessionDelivery(entry.id, queueContext),
    );

    expect(mocks.createManagedOutgoingMediaBlocks).toHaveBeenCalledTimes(1);
    const appends = mocks.appendAssistantMessageToSessionTranscript.mock.calls.map(([params]) => [
      params.idempotencyKey,
      params.displayContent,
    ]);
    expect(appends).toHaveLength(2);
    expect(appends[1]).toEqual(appends[0]);
    expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a queued agentTurn continuation after the session key changes", async () => {
    const activeEntry: LoadedSessionEntry = sessionFixture(
      "agent:main:main",
      {
        sessionId: "old-session-id",
        updatedAt: Date.now(),
      },
      { cfg: { commands: { ownerAllowFrom: ["+15550002"] } } },
    );
    const replacementEntry: LoadedSessionEntry = sessionFixture(
      "agent:main:main",
      {
        sessionId: "new-session-id",
        updatedAt: Date.now(),
        status: "done",
        endedAt: Date.now() - 1_000,
      },
      { cfg: { commands: { ownerAllowFrom: ["+15550002"] } } },
    );
    mockRestartContinuation(
      {
        kind: "agentTurn",
        message: "continue after restart",
      },
      "thread-42",
    );
    mocks.loadSessionEntryAsync
      .mockResolvedValueOnce(activeEntry)
      .mockResolvedValue(replacementEntry);

    await wakeRestartSentinel();

    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledWith(
      "continue after restart",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        contextKey: `task:restart-sentinel:${await mocks.enqueueSessionDelivery.mock.results[0]!.value}`,
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
          threadId: "thread-42",
        },
      }),
    );
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledOnce();
    expect(mocks.logWarn).toHaveBeenCalledWith("restart continuation skipped: session changed", {
      sessionKey: "agent:main:main",
      queueId: expect.any(String),
      expectedSessionId: "old-session-id",
      actualSessionId: "new-session-id",
    });
  });

  it("authorizes routed agentTurn continuations while preserving Telegram topic routing", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:telegram:group:-1003826723328:topic:13757",
        ts: 123,
        continuation: {
          kind: "agentTurn",
          message: "continue in topic",
        },
      },
    } as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:telegram:group:-1003826723328",
      threadId: "13757",
    });
    mocks.loadSessionEntryAsync.mockResolvedValue(
      sessionFixture("agent:main:telegram:group:-1003826723328:topic:13757", {
        sessionId: "agent:main:telegram:group:-1003826723328:topic:13757",
        updatedAt: 0,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram" },
          origin: { provider: "telegram", chatType: "group" },
        }),
      }),
    );
    mocks.deliveryContextFromSession.mockReturnValue({
      channel: "telegram",
      to: "-1003826723328:topic:13757",
      accountId: "default",
      threadId: 13757,
    });
    mocks.resolveOutboundTarget.mockReturnValue({
      ok: true as const,
      to: "-1003826723328:topic:13757",
    });
    setNoticeOwner("-1003826723328:topic:13757");

    await wakeRestartSentinel();

    expectContinuationDispatchFields(
      {
        channel: "telegram",
        accountId: "default",
        routeSessionKey: "agent:main:telegram:group:-1003826723328:topic:13757",
        replyOptions: expect.objectContaining({ sourceReplyDeliveryMode: "message_tool_only" }),
      },
      {
        Body: "continue in topic",
        CommandAuthorized: true,
        GatewayClientScopes: ["operator.admin"],
        GatewayClientCaps: [],
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "telegram",
          sourceTool: "restart-sentinel",
        },
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "group",
        OriginatingChannel: "telegram",
        OriginatingTo: "-1003826723328:topic:13757",
        ExplicitDeliverRoute: false,
        MessageThreadId: "13757",
      },
    );
  });

  it("preserves derived reply transport ids in internal continuation context", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      meta: {
        id: "whatsapp",
        label: "WhatsApp",
        selectionLabel: "WhatsApp",
        docsPath: "/channels/whatsapp",
        blurb: "WhatsApp",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      threading: {
        resolveReplyTransport: ({ threadId }: { threadId?: string | number | null }) => ({
          replyToId: threadId != null ? `reply:${String(threadId)}` : undefined,
          threadId: null,
        }),
      },
    });
    mockRestartContinuation(
      {
        kind: "agentTurn",
        message: "continue",
      },
      "thread-42",
    );
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(async (params) => {
      await params.deliver({
        text: "done",
        replyToId: "restart-sentinel:agent:main:main:agentTurn:123",
      });
    });

    await wakeRestartSentinel();

    expectContinuationDispatchFields(
      {},
      {
        ReplyToId: "reply:thread-42",
        MessageThreadId: undefined,
      },
    );
    const deliveredContinuationReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === "done") === true);
    expect(deliveredContinuationReply).toBe(false);
  });

  it("logs and continues when continuation dispatch reports a delivery error", async () => {
    mockRestartContinuation({
      kind: "agentTurn",
      message: "continue",
    });
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(
      async (params: { onDispatchError: (err: unknown, info: { kind: string }) => void }) => {
        params.onDispatchError(new Error("route failed"), { kind: "final" });
      },
    );

    await wakeRestartSentinel();

    expect(mocks.logWarn.mock.calls[0]).toEqual([
      "restart continuation dispatch failed during final: Error: route failed",
      {
        sessionKey: "agent:main:main",
      },
    ]);
    expect(mocks.logWarn.mock.calls[1]?.[0]).toMatch(
      /^restart continuation: retry failed for entry [0-9a-f]{64}: route failed$/,
    );
  });

  it("retries restart continuations when the previous run is still shutting down", async () => {
    const busyReply = "⚠️ Previous run is still shutting down. Please try again in a moment.";
    let attempt = 0;
    mockRestartContinuation({ kind: "agentTurn", message: "continue" }, undefined, 123);
    mocks.recordInboundSessionAndDispatchReply.mockImplementation(async (params) => {
      attempt += 1;
      if (attempt <= 2) {
        await params.deliver({ text: busyReply });
        return;
      }
      await params.deliver({
        text: "done",
        replyToId: String(params.ctxPayload.MessageSid),
      });
    });

    await wakeRestartSentinel();

    expectMockCallFields(mocks.enqueueSessionDelivery, {
      maxRetries: 20,
    });
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(3);
    expectContinuationDispatchFields(
      {},
      { MessageSid: "restart-sentinel:agent:main:main:agentTurn:123" },
      0,
    );
    expectContinuationDispatchFields(
      {},
      { MessageSid: "restart-sentinel:agent:main:main:agentTurn:123:retry:2" },
      2,
    );
    const deliveredBusyReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === busyReply) === true);
    expect(deliveredBusyReply).toBe(false);
    const deliveredFinalReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === "done") === true);
    expect(deliveredFinalReply).toBe(false);
    expectRecordFields(lastMockCallArg(mocks.deliverOutboundPayloads), {
      payloads: [{ text: "restart message" }],
    });
    expect(mocks.logWarn).toHaveBeenCalledTimes(2);
    for (const [message] of mocks.logWarn.mock.calls) {
      expect(message).toMatch(
        /^restart continuation: retry failed for entry [0-9a-f]{64}: restart continuation deferred because previous run is still shutting down$/,
      );
    }
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
  });

  it("records an unroutable continuation without a diagnostic wake", async () => {
    mockRestartContinuation({ kind: "agentTurn", message: "continue" }, "thread-42");
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error("missing route"),
    });

    await wakeRestartSentinel();

    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(mocks.clearSentinel).toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("lifecycle notice skipped: no delivery target", {
      runId: undefined,
    });
  });

  it("keeps the sentinel file when durable continuation handoff fails", async () => {
    mockRestartContinuation({
      kind: "agentTurn",
      message: "continue",
    });
    mocks.enqueueSessionDelivery.mockRejectedValueOnce(new Error("queue write failed"));

    await wakeRestartSentinel();

    expect(mocks.clearSentinel).not.toHaveBeenCalled();
    expect(mocks.drainPendingSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("startup task failed", {
      source: "restart-sentinel",
      sessionKey: "agent:main:main",
      reason: "queue write failed",
    });
  });

  it("delivers the activation Doctor rollback notice after the previous Gateway starts", async () => {
    const actualSentinel = await vi.importActual<typeof import("../infra/restart-sentinel.js")>(
      "../infra/restart-sentinel.js",
    );
    const { writeControlPlaneUpdateRestartSentinel } =
      await import("../infra/update-control-plane-sentinel.js");
    const sessionKey = "agent:ops:telegram:group:room-77";
    const run = createUpdateRun({
      trigger: "cli",
      origin: {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "room-77",
          accountId: "bot",
          threadId: "topic-7",
        },
      },
    });
    finishUpdateRun(run.runId, { status: "rolled-back", reason: "authority-check-failed" });
    await writeControlPlaneUpdateRestartSentinel({
      meta: { runId: run.runId, handoffId: "original-helper" },
      result: {
        status: "error",
        mode: "npm",
        reason: "authority-check-failed",
        steps: [],
        durationMs: 1,
      },
    });
    mocks.readRestartSentinel.mockResolvedValue(
      (await actualSentinel.readRestartSentinel()) as RestartSentinel,
    );
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "room-77" });
    setNoticeOwner("telegram:room-77");
    await wakeRestartSentinel();
    expect(mocks.loadSessionEntryAsync).toHaveBeenCalledWith(
      sessionKey,
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR }),
      }),
    );
    expect(mocks.resolveSystemMainSessionTarget).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "room-77",
        accountId: "bot",
        threadId: "topic-7",
        payloads: [
          expect.objectContaining({
            text: expect.stringContaining("returned to the previous version"),
          }),
        ],
      }),
    );
    expect(getUpdateRun(run.runId)).toMatchObject({
      status: "rolled-back",
      reason: "authority-check-failed",
      verification: { noticeDelivered: true },
    });
  });

  it.each([{ status: "failed", consumed: false }] as const)(
    "consumes only a targetless CLI outcome without a model wake ($status, $consumed)",
    async ({ status, consumed }) => {
      const run = createUpdateRun({ trigger: "cli" });
      const terminal = finishUpdateRun(run.runId, { status, reason: "original-cli-outcome" });
      mocks.clearSentinel.mockResolvedValueOnce(consumed);
      mocks.readRestartSentinel.mockResolvedValue(
        sentinelFixture({
          kind: "update",
          status: "error",
          ts: 123,
          message: null,
          doctorHint: "Run openclaw doctor --non-interactive",
          stats: { runId: run.runId },
        }),
      );
      await wakeRestartSentinel();
      expect(mocks.clearSentinel).toHaveBeenCalledExactlyOnceWith(123, queueContext.environment);
      expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
      expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
      expect(mocks.drainPendingSessionDelivery).not.toHaveBeenCalled();
      expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
      expect(getUpdateRun(run.runId)).toEqual(terminal);
    },
  );

  it("preserves an explicit targetless CLI note", async () => {
    const run = createUpdateRun({ trigger: "cli" });
    finishUpdateRun(run.runId, { status: "failed" });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({
        kind: "update",
        status: "error",
        ts: 123,
        message: "explicit follow-up",
        stats: { runId: run.runId },
      }),
    );
    await wakeRestartSentinel();
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
      "restart message",
      expect.objectContaining({ sessionKey: "agent:ops:main", source: "restart" }),
    );
  });

  it("keeps a targetless Control UI update out of the ambient chat", async () => {
    const run = createUpdateRun({ trigger: "control-ui" });
    finishUpdateRun(run.runId, { status: "succeeded" });
    mocks.deliveryContextFromSession.mockReturnValue({ channel: "whatsapp", to: "+15550002" });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({ kind: "update", status: "ok", ts: 123, stats: { runId: run.runId } }),
    );

    await wakeRestartSentinel();

    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.resolveSystemMainSessionTarget).not.toHaveBeenCalled();
    expect(mocks.clearSentinel).toHaveBeenCalledWith(123, queueContext.environment);
    expect(getUpdateRun(run.runId)?.verification.noticeDelivered).toBe(false);
  });

  it.each(["config-patch", "config-apply"] as const)(
    "consumes a targetless %s acknowledgement without waking an agent",
    async (kind) => {
      mocks.readRestartSentinel.mockResolvedValue(
        sentinelFixture({
          kind,
          status: "ok",
          ts: 123,
          sessionKey: undefined,
          deliveryContext: undefined,
          threadId: undefined,
          message: null,
          doctorHint: "Run openclaw doctor --non-interactive",
          stats: {
            mode: kind === "config-patch" ? "config.patch" : "config.apply",
            root: "/tmp/openclaw.json",
            requiresRestart: true,
          },
        }),
      );

      await wakeRestartSentinel();

      expect(mocks.clearSentinel).toHaveBeenCalledOnce();
      expect(mocks.clearSentinel).toHaveBeenCalledWith(123, queueContext.environment);
      expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
      expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
      expect(mocks.drainPendingSessionDelivery).not.toHaveBeenCalled();
    },
  );

  it("routes a targetless update through the system base session without resuming it", async () => {
    const baseSessionKey = "agent:ops:main";
    const sessionKey = `${baseSessionKey}:thread:99`;
    const context = { channel: "telegram", to: "123", accountId: "bot", threadId: "7" };
    mocks.resolveSystemMainSessionTarget.mockReturnValue({ agentId: "ops", sessionKey });
    mocks.parseSessionThreadInfo.mockImplementation((key?: string) => ({
      baseSessionKey: key === sessionKey ? baseSessionKey : key,
      threadId: key === sessionKey ? "99" : undefined,
    }));
    const loadSession = mocks.loadSessionEntryAsync.getMockImplementation()!;
    mocks.loadSessionEntryAsync.mockImplementation(async (key) => ({
      ...(await loadSession(key)),
      entry: {
        sessionId: key,
        updatedAt: 0,
        delivery: normalizeSessionDeliveryState({
          context: key === baseSessionKey ? context : undefined,
        }),
      },
    }));
    const delivery = await vi.importActual<typeof import("../utils/delivery-context.read.js")>(
      "../utils/delivery-context.read.js",
    );
    mocks.deliveryContextFromSession.mockImplementation(delivery.deliveryContextFromSession);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "123" });
    setNoticeOwner("telegram:123");
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({
        kind: "update",
        status: "ok",
        ts: 123,
        continuation: { kind: "agentTurn", message: "must not continue an inferred session" },
      }),
    );

    await wakeRestartSentinel();

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123",
        accountId: "bot",
        threadId: "7",
        payloads: [
          {
            text: "✅ OpenClaw updated.\nFor details, open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.",
          },
        ],
      }),
    );
    const eventOptions = mocks.enqueueSessionEvent.mock.calls[0]?.[1];
    expect(eventOptions).toMatchObject({
      sessionKey,
      deliveryContext: context,
    });
    expect(eventOptions).toMatchObject({ source: "restart", agentId: "ops" });
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "restart summary: continuation skipped: restart sentinel sessionKey unavailable",
      { sessionKey, continuationKind: "agentTurn" },
    );
  });

  it("records targetless non-delivery when system-agent ownership is missing", async () => {
    mocks.resolveSystemMainSessionTarget.mockImplementation(() => {
      throw new Error(
        "Multiple agents are configured, but system-agent consult routing has no explicit owner. Set agents.defaults.systemAgent.agentId or pass an explicit consult agent id.",
      );
    });
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({ kind: "restart", status: "ok", ts: 123, message: "restart message" }),
    );

    await wakeRestartSentinel();

    expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.clearSentinel).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("startup task failed", {
      source: "restart-sentinel",
      reason: expect.stringContaining("Set agents.defaults.systemAgent.agentId"),
    });
  });

  it("resolves session routing before handing off the ordinary event", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:qa-channel:channel:qa-room",
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:qa-channel:channel:qa-room",
      threadId: undefined,
    });
    mocks.deliveryContextFromSession.mockReturnValue({
      channel: "qa-channel",
      to: "channel:qa-room",
    });
    const enqueueEvent = mocks.enqueueSessionEvent.getMockImplementation()!;
    mocks.enqueueSessionEvent.mockImplementation((...args) => {
      mocks.deliveryContextFromSession.mockReturnValue({
        channel: "qa-channel",
        to: "changed-after-handoff",
      });
      return enqueueEvent(...args);
    });
    mocks.resolveOutboundTarget.mockImplementation((params?: { to?: string }) => ({
      ok: true as const,
      to: params?.to ?? "missing",
    }));
    setNoticeOwner("channel:qa-room");

    await wakeRestartSentinel();

    expect(mocks.enqueueSessionEvent).toHaveBeenCalledOnce();
    expectMockCallFields(mocks.resolveOutboundTarget, {
      channel: "qa-channel",
      to: "channel:qa-room",
    });
    expectMockCallFields(mocks.deliverOutboundPayloads, {
      channel: "qa-channel",
      to: "channel:qa-room",
    });
  });

  it("merges base session routing into partial thread metadata", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      commands: { ownerAllowFrom: ["room:!MixedCase:example.org"] },
    });
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:matrix:channel:!lowercased:example.org:thread:$thread-event",
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:matrix:channel:!lowercased:example.org",
      threadId: "$thread-event",
    });
    mocks.loadSessionEntryAsync
      .mockResolvedValueOnce(
        sessionFixture(
          "agent:main:matrix:channel:!lowercased:example.org:thread:$thread-event",
          {
            sessionId: "agent:main:matrix:channel:!lowercased:example.org:thread:$thread-event",
            updatedAt: 0,
            delivery: normalizeSessionDeliveryState({
              context: { channel: "matrix", accountId: "acct-thread", threadId: "$thread-event" },
              origin: { provider: "matrix", accountId: "acct-thread", threadId: "$thread-event" },
            }),
          },
          { cfg: { commands: { ownerAllowFrom: ["room:!MixedCase:example.org"] } } },
        ),
      )
      .mockResolvedValueOnce(
        sessionFixture("agent:main:matrix:channel:!lowercased:example.org", {
          sessionId: "agent:main:matrix:channel:!lowercased:example.org",
          updatedAt: 0,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "room:!MixedCase:example.org" },
          }),
        }),
      );
    mocks.deliveryContextFromSession
      .mockReturnValueOnce({
        channel: "matrix",
        accountId: "acct-thread",
        threadId: "$thread-event",
      })
      .mockReturnValueOnce({ channel: "matrix", to: "room:!MixedCase:example.org" });
    mocks.resolveOutboundTarget.mockReturnValue({
      ok: true as const,
      to: "room:!MixedCase:example.org",
    });

    await wakeRestartSentinel();

    expectMockCallFields(mocks.resolveOutboundTarget, {
      channel: "matrix",
      to: "room:!MixedCase:example.org",
      accountId: "acct-thread",
    });
    expectMockCallFields(mocks.deliverOutboundPayloads, {
      channel: "matrix",
      to: "room:!MixedCase:example.org",
      accountId: "acct-thread",
      threadId: "$thread-event",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
