import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
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
  createRestartSentinelSessionFixture as sessionFixture,
  expectCapturedQueueContext,
  expectRestartSentinelTranscriptBroadcast,
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
    deferSessionDelivery: mocks.deferSessionDelivery,
    failSessionDelivery: mocks.failSessionDelivery,
    mergeSessionDeliveryPreparedMediaBlocks: mocks.mergeSessionDeliveryPreparedMediaBlocks,
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

const queueFixtures = await import("../infra/session-delivery-queue.test-helpers.js");
const {
  deliverQueuedSessionDelivery,
  recoverPendingProducedSessionDeliveries,
  scheduleRestartSentinelWake,
  settleQueuedSessionDelivery,
} = await import("./server-restart-sentinel.js");
const { resetGatewayWorkAdmission } = await import("../process/gateway-work-admission.js");
const actualRestartUpdateRun = await vi.importActual<
  typeof import("./server-restart-update-run.js")
>("./server-restart-update-run.js");

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

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let testState: OpenClawTestState;
let queueContext: OpenClawStateWorkerContext;
let sessionDeliveryPublications: string[];

function wakeRestartSentinel() {
  return scheduleRestartSentinelWake({ scheduler, signal: scheduler.signal, deps: {} });
}

const expectQueueContext = (stateDir = testState.stateDir) => expectCapturedQueueContext(stateDir);

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
    sessionDeliveryPublications = await queueFixtures.observeSessionDeliveryPublications();
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
    await recoverPendingProducedSessionDeliveries({ deps: {} as never, queueContext });

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
    expect(sessionDeliveryPublications).toEqual([]);
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
      if (channel === "webchat") {
        const sessionKey = "agent:main:main";
        const entry = { sessionId: "main", updatedAt: 1 };
        const storePath = testState.statePath("agents", "main", "sessions", "sessions.json");
        await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, entry);
        mocks.loadSessionEntryAsync.mockResolvedValue(
          sessionFixture(sessionKey, entry, { agentId: "main", storePath }),
        );
      }
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
      expect.soft(sessionDeliveryPublications).toEqual([]);
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
      expect(sessionDeliveryPublications).toEqual([]);
      expect(mocks.logWarn).not.toHaveBeenCalled();
    } finally {
      mocks.mergeDeliveryContext.mockImplementation(originalMerge);
      unsubscribe();
      await Promise.allSettled(publications);
      rowProjection.dispose();
    }
  });

  it("stops delivery when guarded sentinel consumption fails", async () => {
    mocks.clearSentinel.mockRejectedValueOnce(new Error("database locked"));

    await wakeRestartSentinel();

    expect(sessionDeliveryPublications).toEqual([]);
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
    const id = await queueFixtures.enqueueUnclaimedSessionDeliveryFixture(payload, queueContext);
    const entry = await mocks.loadPendingSessionDelivery(id, queueContext);
    if (entry?.kind !== "agentTurn") {
      throw new Error("expected queued generated media");
    }
    return entry as Parameters<typeof createGeneratedMediaDeliveryEntry>[0];
  }

  async function deliverProducedMedia(
    entry: Parameters<typeof createGeneratedMediaDeliveryEntry>[0],
  ) {
    await deliverGeneratedMedia(entry);
  }

  it("sends already-produced generated media without another agent turn", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-1:agent-loop",
      route: { channel: "discord", to: "channel:123", accountId: "default", chatType: "channel" },
      sourceReplyDeliveryMode: "message_tool_only",
      expectedMediaUrls: ["/tmp/proof.png"],
    });
    expect(sessionDeliveryPublications).toEqual(["sessionDelivery.enqueue"]);

    await deliverProducedMedia(entry);

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
  });

  it("keeps a rearmed internal media row clear of the retired transcript identity", async () => {
    const entry = await enqueueGeneratedMedia({
      messageId: "image:task-internal-upgrade:agent-loop",
      route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
      expectedMediaUrls: ["/tmp/two.png"],
    });
    // An older release already wrote one.png under the base key, then rearmed.
    // Legacy attempts retain their transcript key suffix, without an execution writer.
    entry.agentRunAttempt = 1;

    await deliverProducedMedia(entry);

    const keys = mocks.appendAssistantMessageToSessionTranscript.mock.calls.map(
      ([params]) => params.idempotencyKey,
    );
    expect(keys).toEqual([
      "image:task-internal-upgrade:agent-loop:attempt:1:generated-media-host-transcript",
    ]);
    expect(keys).not.toContain("image:task-internal-upgrade:agent-loop:generated-media-transcript");
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
  });

  it("persists internal generated media in the owning transcript without another turn", async () => {
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

    await deliverProducedMedia(entry);

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
    await deliverProducedMedia(await mocks.loadPendingSessionDelivery(entry.id, queueContext));

    expect(mocks.createManagedOutgoingMediaBlocks).toHaveBeenCalledTimes(1);
    const appends = mocks.appendAssistantMessageToSessionTranscript.mock.calls.map(([params]) => [
      params.idempotencyKey,
      params.displayContent,
    ]);
    expect(appends).toHaveLength(2);
    expect(appends[1]).toEqual(appends[0]);
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

  it("preserves an explicit targetless CLI note", async () => {
    const sessionKey = "agent:ops:main";
    const entry = { sessionId: "system-note", updatedAt: 1 };
    const storePath = testState.statePath("agents", "ops", "sessions", "sessions.json");
    await upsertSessionEntryCore({ agentId: "ops", sessionKey, storePath }, entry);
    mocks.loadSessionEntryAsync.mockResolvedValue(
      sessionFixture(sessionKey, entry, { agentId: "ops", storePath }),
    );
    const transcript = await vi.importActual<typeof import("../config/sessions/transcript.js")>(
      "../config/sessions/transcript.js",
    );
    mocks.appendAssistantMessageToSessionTranscript.mockImplementation(
      transcript.appendAssistantMessageToSessionTranscript,
    );
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
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionKey,
        text: renderUpdateRunSummary(getUpdateRun(run.runId)!),
      }),
    );
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(getUpdateRun(run.runId)?.verification.noticeDelivered).toBe(true);
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
    expect(sessionDeliveryPublications).toEqual([]);
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.resolveSystemMainSessionTarget).not.toHaveBeenCalled();
    expect(mocks.clearSentinel).toHaveBeenCalledWith(123, queueContext.environment);
    expect(getUpdateRun(run.runId)?.verification.noticeDelivered).toBe(false);
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

    expect(sessionDeliveryPublications).toEqual([]);
    expect(mocks.clearSentinel).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("startup task failed", {
      source: "restart-sentinel",
      reason: expect.stringContaining("Set agents.defaults.systemAgent.agentId"),
    });
  });

  it("keeps the notice route captured before durable publication", async () => {
    const sessionKey = "agent:main:qa-channel:channel:qa-room";
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({ kind: "restart", status: "ok", ts: 123, sessionKey }),
    );
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: sessionKey,
      threadId: undefined,
    });
    mocks.deliveryContextFromSession.mockReturnValue({
      channel: "qa-channel",
      to: "channel:qa-room",
    });
    const enqueueNotice = mocks.enqueueDeliveryOnce.getMockImplementation()!;
    mocks.enqueueDeliveryOnce.mockImplementation(async (...args) => {
      mocks.deliveryContextFromSession.mockReturnValue({
        channel: "qa-channel",
        to: "changed-after-publication",
      });
      return enqueueNotice(...args);
    });
    mocks.resolveOutboundTarget.mockImplementation((params?: { to?: string }) => ({
      ok: true,
      to: params?.to ?? "missing",
    }));
    setNoticeOwner("channel:qa-room");

    await wakeRestartSentinel();

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "qa-channel", to: "channel:qa-room" }),
    );
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "qa-channel", to: "channel:qa-room" }),
    );
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
  });

  it("merges base session routing into partial thread metadata for a passive notice", async () => {
    const baseSessionKey = "agent:main:matrix:channel:!lowercased:example.org";
    const sessionKey = `${baseSessionKey}:thread:$thread-event`;
    setNoticeOwner("room:!MixedCase:example.org");
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({ kind: "restart", status: "ok", ts: 123, sessionKey }),
    );
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey,
      threadId: "$thread-event",
    });
    mocks.loadSessionEntryAsync
      .mockResolvedValueOnce(
        sessionFixture(sessionKey, {
          sessionId: sessionKey,
          updatedAt: 0,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", accountId: "acct-thread", threadId: "$thread-event" },
            origin: { provider: "matrix", accountId: "acct-thread", threadId: "$thread-event" },
          }),
        }),
      )
      .mockResolvedValueOnce(
        sessionFixture(baseSessionKey, {
          sessionId: baseSessionKey,
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
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "room:!MixedCase:example.org" });

    await wakeRestartSentinel();

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: "acct-thread",
      }),
    );
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: "acct-thread",
        threadId: "$thread-event",
      }),
    );
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
