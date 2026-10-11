import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlNextRecoverySleep } from "../../../test/helpers/infra/delivery-recovery.js";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import {
  getConversationDeliveryOperation,
  markConversationDeliveryRejected,
  markConversationDeliverySent,
  markConversationDeliverySuppressed,
} from "../../config/sessions/conversation-delivery-store.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { seedDeliveryQueueEntry } from "../delivery-queue-sqlite.test-support.js";
import { resolveDeliveryQueueStateEnv } from "../delivery-queue-state-context.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import { attachOutboundDeliveryCommitHook } from "./delivery-commit-hooks.js";
import { pruneOrphanedDeliveryQueueMedia } from "./delivery-queue-media-spool.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import * as deliveryQueueStorage from "./delivery-queue-storage.js";
import {
  claimDeliveryPlatformSendAttempt,
  enqueueDelivery,
  enqueueDeliveryOnce,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
  reserveDeliveryAttempt,
} from "./delivery-queue-storage.js";
import { createConversationRecoveryFixture as createQueuedConversationRecoveryFixture } from "./delivery-queue.conversation-test-helpers.js";
import {
  RECOVERY_SUMMARY,
  loadPendingDeliveries,
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";
const MAX_RETRIES = 5;
const BOUNDED_COMPLETION_RETENTION = {
  idPrefix: "cron-direct-delivery:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;
const resolveOutboundChannelMessageAdapterMock = vi.hoisted(() => vi.fn());
const sleepMock = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveOutboundChannelMessageAdapterMock,
}));
vi.mock("../../utils/sleep.js", () => ({ sleep: sleepMock }));
function mockCallRecord(mock: { mock: { calls: unknown[][] } }, index = 0) {
  const value = mock.mock.calls[index]?.[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected mock call ${index} argument to be a record`);
  }
  return value as Record<string, unknown>;
}
function expectMockMessageContaining(mock: { mock: { calls: unknown[][] } }, expected: string) {
  const messages = mock.mock.calls.map((call) => (typeof call[0] === "string" ? call[0] : ""));
  expect(messages.join("\n")).toContain(expected);
}
function captureAuditEvents() {
  const auditEvents: TrustedMessageAuditEvent[] = [];
  return {
    auditEvents,
    unsubscribe: onTrustedMessageAuditEvent((event) => auditEvents.push(event)),
  };
}
function expectPayloadAudits(
  auditEvents: TrustedMessageAuditEvent[],
  queueId: string,
  expected: Array<Record<string, unknown>>,
) {
  expect(auditEvents).toHaveLength(expected.length);
  expected.forEach((event, index) =>
    expect(auditEvents[index]).toMatchObject({
      sourceId: `message:outbound:queue:${queueId}:payload:${index}`,
      ...event,
    }),
  );
}
type PayloadOutcomeSink = Pick<Parameters<DeliverFn>[0], "onPayloadDeliveryOutcome">;
function reportPayloadFailure(
  params: PayloadOutcomeSink,
  error: Error,
  overrides: Partial<OutboundPayloadDeliveryOutcome> = {},
) {
  params.onPayloadDeliveryOutcome?.({
    index: 0,
    status: "failed",
    error,
    sentBeforeError: false,
    stage: "platform_send",
    ...overrides,
  } as OutboundPayloadDeliveryOutcome);
}
function reconciledSent(messageId: string, sentAt = Date.now()) {
  return {
    status: "sent",
    messageId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text", index: 0 }],
      sentAt,
    },
  };
}
async function runIf(condition: unknown, action: () => unknown) {
  if (condition) {
    await action();
  }
}
async function closeConversationAgentDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}
function readOutboundQueueStatus(tmpDir: string, id: string): string | undefined {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir },
  });
  const row = db
    .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
    .get(OUTBOUND_DELIVERY_QUEUE_NAME, id) as { status?: string } | undefined;
  return row?.status;
}
describe("delivery-queue recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  afterEach(closeConversationAgentDatabases);
  const baseCfg = {};
  function enqueueRecoveryDelivery(params: Partial<Parameters<typeof enqueueDelivery>[0]> = {}) {
    return enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "a" }],
        ...params,
      },
      tmpDir(),
    );
  }
  function enqueueDemoRecoveryDelivery(
    texts: string[] = ["x"],
    params: Partial<Parameters<typeof enqueueDelivery>[0]> = {},
  ) {
    return enqueueRecoveryDelivery({
      channel: "demo-channel-c",
      to: "#ch",
      payloads: texts.map((text) => ({ text })),
      ...params,
    });
  }
  function installUnknownSendAdapter(
    reconcileUnknownSend: ReturnType<typeof vi.fn>,
    durableFinal: Record<string, unknown> = {},
    adapter: Record<string, unknown> = {},
  ) {
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      ...adapter,
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend,
        ...durableFinal,
      },
    });
  }
  function installUnknownSendResult(
    result: Record<string, unknown>,
    durableFinal: Record<string, unknown> = {},
  ) {
    const reconcileUnknownSend = vi.fn().mockResolvedValue(result);
    installUnknownSendAdapter(reconcileUnknownSend, durableFinal);
    return reconcileUnknownSend;
  }
  async function enqueueUnknownRecovery(params: {
    text: string;
    state?: "send_attempt_started" | "unknown_after_send";
    delivery?: Partial<Parameters<typeof enqueueDelivery>[0]>;
    queue?: Record<string, unknown>;
  }) {
    const id = await enqueueRecoveryDelivery({
      payloads: [{ text: params.text }],
      ...params.delivery,
    });
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: params.state ?? "unknown_after_send",
      ...params.queue,
    });
    return id;
  }
  async function expectFailedQueue(id: string) {
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  }
  async function expectPendingEntry(expected: Record<string, unknown>) {
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    const entry = entries[0] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(entry[key]).toEqual(value);
    }
    return entries[0];
  }
  async function enqueueClaimedRecoveryDelivery(
    id: string,
    delivery: Partial<Parameters<typeof enqueueDeliveryOnce>[0]>,
    route?: { replyToId: string | null },
  ) {
    await enqueueDeliveryOnce(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "stable delivery" }],
        queuePolicy: "required",
        ...delivery,
      },
      id,
      tmpDir(),
    );
    const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
    if (!claimId) {
      throw new Error("test invariant: stable delivery must own its platform attempt");
    }
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), route, claimId);
    return claimId;
  }
  beforeEach(() => {
    resolveOutboundChannelMessageAdapterMock.mockReset();
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
  });
  const enqueueCrashRecoveryEntries = async () => {
    await enqueueRecoveryDelivery({
      preparedMessageId: "prepared-message-a",
    });
    await enqueueRecoveryDelivery({
      channel: "demo-channel-b",
      to: "2",
      payloads: [{ text: "b" }],
      queuePolicy: "required",
      requireUnknownSendReconciliation: true,
    });
  };
  const runRecovery = async ({
    deliver,
    log = createRecoveryLog(),
    maxRecoveryMs,
  }: {
    deliver: ReturnType<typeof vi.fn>;
    log?: ReturnType<typeof createRecoveryLog>;
    maxRecoveryMs?: number;
  }) => {
    const result = await recoverPendingDeliveries({
      deliver: asDeliverFn(deliver),
      log,
      cfg: baseCfg,
      stateDir: tmpDir(),
      ...(maxRecoveryMs === undefined ? {} : { maxRecoveryMs }),
    });
    return { result, log };
  };
  async function runRecoveryWithStorageOverrides(params: {
    overrides: Partial<
      Pick<typeof deliveryQueueStorage, "ackDelivery" | "markDeliveryPlatformOutcomeUnknown">
    >;
    deliver: ReturnType<typeof vi.fn>;
  }) {
    const ackSpy = params.overrides.ackDelivery
      ? vi
          .spyOn(deliveryQueueStorage, "ackDelivery")
          .mockImplementation(params.overrides.ackDelivery)
      : undefined;
    const markerSpy = params.overrides.markDeliveryPlatformOutcomeUnknown
      ? vi
          .spyOn(deliveryQueueStorage, "markDeliveryPlatformOutcomeUnknown")
          .mockImplementation(params.overrides.markDeliveryPlatformOutcomeUnknown)
      : undefined;
    try {
      const { result, log } = await runRecovery({ deliver: params.deliver });
      return { summary: result, log };
    } finally {
      ackSpy?.mockRestore();
      markerSpy?.mockRestore();
    }
  }
  const createConversationRecoveryFixture = (
    operationId: string,
    delivery: Partial<Parameters<typeof enqueueDeliveryOnce>[0]> = {},
    stateDir = tmpDir(),
  ) => createQueuedConversationRecoveryFixture({ operationId, delivery, stateDir });
  async function createPendingFinalRecoveryFixture(
    deliveryId: string,
    options: { withWriterAuthority?: boolean } = {},
  ) {
    const sessionKey = "agent:main:demo-channel-a:direct:pending-final";
    const storePath = path.join(tmpDir(), "pending-final-sessions.json");
    const lifecycleRevision = "pending-final-recovery-revision";
    const writerRunId = "pending-final-recovery-writer";
    const completion = {
      kind: "pending-final" as const,
      deliveryId,
      intentId: "pending-final-recovery-intent",
      sessionId: "pending-final-recovery-session",
      sessionKey,
      storePath,
      ...(options.withWriterAuthority
        ? {
            sessionWriterDeliveryAuthority: {
              agentId: "main",
              expectedLifecycleRevision: lifecycleRevision,
              expectedSessionId: "pending-final-recovery-session",
              expectedWriterRunId: writerRunId,
              sessionKey,
              storePath,
            },
          }
        : {}),
    };
    const context = { channel: "demo-channel-a", to: "+1" };
    await replaceSessionEntry(
      { sessionKey, storePath, env: resolveDeliveryQueueStateEnv(tmpDir()) },
      {
        sessionId: completion.sessionId,
        updatedAt: Date.now(),
        ...(options.withWriterAuthority
          ? { activeWriterRunId: writerRunId, lifecycleRevision }
          : {}),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "recovered delivery identity may have been lost",
          context,
          createdAt: Date.now(),
          intentId: completion.intentId,
          deliveries: [{ id: deliveryId, state: "prepared" }],
        },
      },
    );
    await enqueueDeliveryOnce(
      {
        channel: "demo-channel-a",
        to: "+1",
        queuePolicy: "required",
        maxRetries: 1,
        payloads: [{ text: "recovered delivery identity may have been lost" }],
        deliveryCompletion: completion,
      },
      deliveryId,
      tmpDir(),
    );
    return { completion, context };
  }
  it("finalizes a persisted conversation operation during queue recovery", async () => {
    const scope = await createConversationRecoveryFixture("operation-recovery");
    const deliveryResult = { channel: "reef" as const, messageId: "reef-platform" };
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      expect(params.deliveryCompletion).toBeUndefined();
      expect(params.conversationDeliveryAttemptAuthority).toEqual({
        agentId: "main",
        operationId: "operation-recovery",
        storePath: scope.storePath,
        routeFingerprint: "route-recovery",
      });
      await params.onDeliveryResult?.(deliveryResult);
      return [deliveryResult];
    });
    const { result, log } = await runRecovery({ deliver });
    expect(result.recovered, JSON.stringify(log.warn.mock.calls)).toBe(1);
    expect(await getConversationDeliveryOperation(scope, "operation-recovery")).toMatchObject({
      status: "sent",
      queueId: "operation-recovery",
      platformMessageId: "reef-platform",
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });
  it("settles an explicit recovered no-send as suppression without replay", async () => {
    const operationId = "operation-recovered-no-send";
    const scope = await createConversationRecoveryFixture(operationId);
    const { auditEvents, unsubscribe } = captureAuditEvents();
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      await markDeliveryPlatformSendAttemptStarted(
        operationId,
        tmpDir(),
        undefined,
        params.deliveryProducerClaimId,
      );
      await params.onPlatformSendStart?.({});
      params.onPayloadDeliveryOutcome?.({
        index: 0,
        status: "suppressed",
        reason: "adapter_returned_no_send",
      });
      return [];
    });

    try {
      const first = await runRecovery({ deliver });

      expect(first.result).toEqual(RECOVERY_SUMMARY.recovered);
      expect(await getConversationDeliveryOperation(scope, operationId)).toMatchObject({
        status: "suppressed",
      });
      expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
      expectPayloadAudits(auditEvents, operationId, [
        {
          status: "blocked",
          outcome: "suppressed",
          reasonCode: "no_visible_payload",
          resultCount: 0,
        },
      ]);

      await closeConversationAgentDatabases();
      await closeStateDatabaseForTest();
      const second = await runRecovery({ deliver });
      expect(second.result).toEqual(RECOVERY_SUMMARY.empty);
      expect(deliver).toHaveBeenCalledOnce();
      expect((await getConversationDeliveryOperation(scope, operationId))?.status).toBe(
        "suppressed",
      );
      expect(auditEvents).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
  it.each([undefined, "adapter_returned_no_identity"] as const)(
    "keeps an uncertainty notice owed when recovery returns no delivery identity (%s)",
    async (reason) => {
      const deliveryId = "pending-final-unknown-recovery";
      const { completion, context } = await createPendingFinalRecoveryFixture(deliveryId);
      const { auditEvents, unsubscribe } = captureAuditEvents();
      const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
        expect(params.deliveryCompletion).toBeUndefined();
        await markDeliveryPlatformSendAttemptStarted(deliveryId, tmpDir());
        await params.onPlatformSendStart?.({});
        if (reason) {
          params.onPayloadDeliveryOutcome?.({ index: 0, status: "suppressed", reason });
        }
        return [];
      });

      const { result } = await runRecovery({ deliver });

      expect(
        loadSessionEntry({
          sessionKey: completion.sessionKey,
          storePath: completion.storePath,
          env: resolveDeliveryQueueStateEnv(tmpDir()),
        }),
      ).toMatchObject({
        pendingFinalDelivery: {
          deliveries: [{ id: deliveryId, state: "unknown" }],
        },
        pendingDeliveryNotice: {
          intentId: completion.intentId,
          state: "owed",
          context,
        },
      });
      expect(result).toEqual(RECOVERY_SUMMARY.failed);
      await expectPendingEntry({
        id: deliveryId,
        recoveryState: "unknown_after_send",
        retryCount: 1,
      });
      expect(auditEvents).not.toContainEqual(
        expect.objectContaining({ action: "message.outbound.finished" }),
      );

      setQueuedEntryState(tmpDir(), deliveryId, {
        retryCount: 1,
        enqueuedAt: 0,
        lastAttemptAt: 0,
        availableAt: 0,
      });
      const second = await runRecovery({ deliver });
      unsubscribe();

      expect(second.result).toEqual(RECOVERY_SUMMARY.failed);
      expect(deliver).toHaveBeenCalledOnce();
      expect(auditEvents.filter((event) => event.action === "message.outbound.finished")).toEqual([
        expect.objectContaining({
          sourceId: `message:outbound:queue:${deliveryId}:payload:0`,
          outcome: "unknown",
        }),
      ]);
    },
  );
  it.each(["onDirectAdapterHandoff", "onPlatformSendDispatch"] as const)(
    "rejects a recovered pending final before %s after writer replacement",
    async (transportBoundary) => {
      const deliveryId = `pending-final-stale-recovery-${transportBoundary}`;
      const { completion } = await createPendingFinalRecoveryFixture(deliveryId, {
        withWriterAuthority: true,
      });
      const current = loadSessionEntry({
        sessionKey: completion.sessionKey,
        storePath: completion.storePath,
        env: resolveDeliveryQueueStateEnv(tmpDir()),
      });
      if (!current) {
        throw new Error("test invariant: pending-final recovery session must exist");
      }
      await replaceSessionEntry(
        {
          sessionKey: completion.sessionKey,
          storePath: completion.storePath,
          env: resolveDeliveryQueueStateEnv(tmpDir()),
        },
        {
          ...current,
          activeWriterRunId: "replacement-writer",
          lifecycleRevision: "replacement-revision",
          updatedAt: Date.now(),
        },
      );
      const platformSend = vi.fn();
      const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
        await params[transportBoundary]?.();
        await platformSend();
        return [];
      });

      const { result } = await runRecovery({ deliver });

      expect(deliver).toHaveBeenCalledOnce();
      expect(platformSend).not.toHaveBeenCalled();
      expect(result).toEqual(RECOVERY_SUMMARY.failed);
    },
  );
  it("rejects a recovered pending final when its writer changes after the awaited handoff", async () => {
    const deliveryId = "pending-final-stale-after-handoff";
    const { completion } = await createPendingFinalRecoveryFixture(deliveryId, {
      withWriterAuthority: true,
    });
    const platformSend = vi.fn();
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      await params.onDirectAdapterHandoff?.();
      const current = loadSessionEntry({
        sessionKey: completion.sessionKey,
        storePath: completion.storePath,
        env: resolveDeliveryQueueStateEnv(tmpDir()),
      });
      if (!current) {
        throw new Error("test invariant: pending-final recovery session must exist");
      }
      await replaceSessionEntry(
        {
          sessionKey: completion.sessionKey,
          storePath: completion.storePath,
          env: resolveDeliveryQueueStateEnv(tmpDir()),
        },
        {
          ...current,
          activeWriterRunId: "replacement-writer",
          lifecycleRevision: "replacement-revision",
          updatedAt: Date.now(),
        },
      );
      params.assertDirectAdapterHandoff?.();
      await platformSend();
      return [];
    });

    const { result } = await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledOnce();
    expect(platformSend).not.toHaveBeenCalled();
    expect(result).toEqual(RECOVERY_SUMMARY.failed);
  });
  it.each(["suppressed", "rejected", "sent"] as const)(
    "acks a persisted %s conversation operation without replaying it",
    async (state) => {
      const rejected = state === "rejected";
      const operationId = `operation-${state}`;
      const scope = await createConversationRecoveryFixture(operationId);
      await runIf(rejected, () =>
        markConversationDeliveryRejected(scope, operationId, "atomic message limit"),
      );
      await runIf(state === "suppressed", () =>
        markConversationDeliverySuppressed(scope, operationId),
      );
      await runIf(state === "sent", () =>
        markConversationDeliverySent(scope, operationId, "reef-platform"),
      );
      const deliver = vi.fn();
      await closeConversationAgentDatabases();
      await closeStateDatabaseForTest();
      const { auditEvents, unsubscribe } = captureAuditEvents();
      try {
        const { result } = await runRecovery({ deliver });
        expect(result).toMatchObject(rejected ? { failed: 1 } : { recovered: 1 });
        expect(deliver).not.toHaveBeenCalled();
        expect(await getConversationDeliveryOperation(scope, operationId)).toMatchObject(
          rejected
            ? { status: "rejected", rejectionError: "atomic message limit" }
            : { status: state },
        );
        expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
        expectPayloadAudits(auditEvents, operationId, [
          rejected
            ? { outcome: "failed", resultCount: 0 }
            : state === "sent"
              ? { outcome: "sent", resultCount: 1 }
              : { outcome: "suppressed", reasonCode: "no_visible_payload", resultCount: 0 },
        ]);
        await closeConversationAgentDatabases();
        await closeStateDatabaseForTest();
        expect((await runRecovery({ deliver })).result).toEqual(RECOVERY_SUMMARY.empty);
        expect(auditEvents).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    },
  );
  it("rejects blocked rows before backoff or reconciliation", async () => {
    const { auditEvents, unsubscribe } = captureAuditEvents();
    const id = await enqueueRecoveryDelivery({
      channel: "slack",
      to: "C123",
      accountId: "enterprise",
    });
    setQueuedEntryState(tmpDir(), id, {
      retryCount: MAX_RETRIES,
      lastAttemptAt: Date.now(),
      recoveryState: "unknown_after_send",
      platformSendStartedAt: Date.now(),
    });
    const reconcileUnknownSend = vi.fn();
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        admitDeferredDelivery: () => ({
          status: "permanent_rejection",
          reason: "unsupported_enterprise_slack_delivery",
        }),
        reconcileUnknownSend,
      },
    });
    const deliver = vi.fn();
    try {
      expect((await runRecovery({ deliver })).result).toEqual(RECOVERY_SUMMARY.failed);
      expect(reconcileUnknownSend).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
      expectPayloadAudits(auditEvents, id, [
        { status: "unknown", outcome: "unknown", failureStage: "queue" },
      ]);
      resolveOutboundChannelMessageAdapterMock.mockReturnValue({
        durableFinal: { admitDeferredDelivery: () => ({ status: "allowed" }) },
      });
      await runRecovery({ deliver });
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  it("counts replay pacing against the recovery budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
    try {
      const controlledSleep = controlNextRecoverySleep(sleepMock);
      await enqueueCrashRecoveryEntries();
      await enqueueDemoRecoveryDelivery(["c"]);
      const deliver = vi.fn().mockResolvedValue([]);
      const recovery = runRecovery({ deliver, maxRecoveryMs: 1 });
      await expect(controlledSleep.started).resolves.toBe(1);
      expect(deliver).toHaveBeenCalledOnce();
      controlledSleep.release();
      expect((await recovery).result).toMatchObject({ recovered: 1, deferredBackoff: 0 });
      expect(deliver).toHaveBeenCalledOnce();
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    { maxRetries: 45, retryCount: MAX_RETRIES },
    { maxRetries: 0.5, retryCount: 0 },
  ])(
    "replays within the resolved budget ($maxRetries, $retryCount)",
    async ({ maxRetries, retryCount }) => {
      const id = await enqueueRecoveryDelivery({ maxRetries });
      setQueuedEntryState(tmpDir(), id, { retryCount, lastAttemptAt: Date.now() - 10_000_000 });
      const deliver = vi.fn().mockResolvedValue([]);
      expect((await runRecovery({ deliver })).result).toMatchObject({
        recovered: 1,
        skippedMaxRetries: 0,
      });
      expect(deliver).toHaveBeenCalledOnce();
      expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
    },
  );
  it("dead-letters max-retry entries even when conversation owner state is missing", async () => {
    const storePath = path.join(tmpDir(), "missing-owner-sessions.json");
    const id = await enqueueRecoveryDelivery({
      deliveryCompletion: {
        kind: "conversation",
        agentId: "main",
        operationId: "missing-operation",
        storePath,
      },
    });
    setQueuedEntryState(tmpDir(), id, { retryCount: MAX_RETRIES });
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver: vi.fn(), log });
    expect(result.skippedMaxRetries).toBe(1);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("settlement");
  });
  it("keeps a partially sent batch unknown when a later send has a permanent rejection", async () => {
    const id = await enqueueDemoRecoveryDelivery(["first", "second"]);
    const rejection = new PlatformMessageNotDispatchedError(
      "Slack outbound delivery rejected: messages_tab_disabled",
      { cause: new Error("messages_tab_disabled"), retryable: false },
    );
    const partialFailure = new OutboundDeliveryError("second send failed", {
      cause: rejection,
      results: [{ channel: "demo-channel-c", messageId: "m1" }],
      payloadOutcomes: [
        { index: 0, status: "sent", results: [{ channel: "demo-channel-c", messageId: "m1" }] },
        {
          index: 1,
          status: "failed",
          error: rejection,
          sentBeforeError: false,
          stage: "platform_send",
        },
      ],
      stage: "platform_send",
    });

    const { result } = await runRecovery({
      deliver: vi.fn().mockRejectedValue(partialFailure),
    });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    await expectPendingEntry({ id, recoveryState: "unknown_after_send", retryCount: 0 });
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("pending");
    const replay = vi.fn();
    await runRecovery({ deliver: replay });
    expect(replay).not.toHaveBeenCalled();
    await expectFailedQueue(id);
  });
  const preConnectFailure = Object.assign(new Error("getaddrinfo EAI_AGAIN"), {
    code: "EAI_AGAIN",
    syscall: "getaddrinfo",
  });
  const notDispatched = new PlatformMessageNotDispatchedError("upload timed out before dispatch", {
    cause: new Error("request timed out"),
  });
  const permanentRejection = new PlatformMessageNotDispatchedError("chat not found", {
    cause: new Error("provider rejected before dispatch"),
    retryable: false,
  });
  const ambiguousRead = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
    syscall: "read",
  });
  it.each([
    ["pre-connect failure", [preConnectFailure], undefined, undefined],
    ["not dispatched after suppression", [notDispatched], "adapter_returned_no_send", undefined],
    ["unmarked failure", [new Error("network down")], undefined, "unmarked"],
    ["transient-first batch", [notDispatched, permanentRejection], undefined, undefined],
    ["all-permanent batch", [permanentRejection, permanentRejection], undefined, "terminal"],
    ["ambiguous read", [notDispatched, ambiguousRead], undefined, "send_attempt_started"],
  ] as const)(
    "classifies best-effort recovery: %s (%s, %s)",
    async (_, errors, precedingReason, state) => {
      const texts = errors.map((error) => error.message);
      if (precedingReason) {
        texts.unshift("suppressed");
      }
      const id = await enqueueDemoRecoveryDelivery(texts, { bestEffort: true });
      const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
        if (state !== "unmarked") {
          await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
          if (state !== "send_attempt_started") {
            await params.onPlatformSendStart?.({});
          }
        }
        if (precedingReason) {
          params.onPayloadDeliveryOutcome?.({
            index: 0,
            status: "suppressed",
            reason: precedingReason,
          });
        }
        errors.forEach((error, index) =>
          reportPayloadFailure(params, error, { index: index + (precedingReason ? 1 : 0) }),
        );
        return [];
      });
      const { result } = await runRecovery({ deliver });
      expect(result).toMatchObject({ recovered: 0, failed: 1 });
      if (state === "terminal") {
        await expectFailedQueue(id);
        return;
      }
      const recoveryState = state === "unmarked" ? undefined : state;
      const entry = await expectPendingEntry({
        id,
        retryCount: 1,
        recoveryState,
        settlement: undefined,
      });
      if (state === "unmarked") {
        expect(entry?.lastError).toBe("network down");
      }
      expect(entry?.platformSendStartedAt).toEqual(recoveryState ? expect.any(Number) : undefined);
      expect(readOutboundQueueStatus(tmpDir(), id)).toBe("pending");
    },
  );
  it("does not ack an identityless partially sent best-effort batch", async () => {
    const id = await enqueueDemoRecoveryDelivery(["first", "second"], { bestEffort: true });
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      await params.onPlatformSendStart?.({});
      reportPayloadFailure(params, new Error("second send failed"), {
        index: 1,
        sentBeforeError: true,
      });
      return [];
    });
    const { result } = await runRecovery({ deliver });
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    await expectPendingEntry({ id, recoveryState: "unknown_after_send", retryCount: 0 });
    const replay = vi.fn();
    await runRecovery({ deliver: replay });
    expect(replay).not.toHaveBeenCalled();
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  });
  it("reconciles an unknown stable send after restart recovery waits for its lease expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
    try {
      const id = "cron-direct-delivery:v1:restart-before-producer-lease-expiry";
      const originalClaimId = await enqueueClaimedRecoveryDelivery(id, {
        completionRetention: BOUNDED_COMPLETION_RETENTION,
        requiresProducerClaim: true,
      });
      await markDeliveryPlatformOutcomeUnknown(id, tmpDir(), originalClaimId);
      const leaseExpiry = (await loadPendingDeliveries(tmpDir()))[0]?.availableAt;
      if (leaseExpiry === undefined) {
        throw new Error("test invariant: the stable producer claim must have an expiry");
      }

      const reconcileUnknownSend = installUnknownSendResult(
        reconciledSent("reconciled-after-expiry", leaseExpiry),
      );
      const deliver = vi.fn();

      const firstRun = await runRecovery({ deliver });
      expect(firstRun.result).toMatchObject({
        recovered: 0,
        failed: 0,
      });
      expect(reconcileUnknownSend).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();

      vi.setSystemTime(leaseExpiry + 1);
      const secondRun = await runRecovery({ deliver });

      expect(secondRun.result).toMatchObject({ recovered: 1, failed: 0 });
      expect(reconcileUnknownSend).toHaveBeenCalledOnce();
      expect(deliver).not.toHaveBeenCalled();
      expect(readOutboundQueueStatus(tmpDir(), id)).toBe("completed");
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("atomically fences stable recovery after an adapter proves an ambiguous send was not sent", async () => {
    const id = "cron-direct-delivery:v1:reconciled-stable-recovery";
    await enqueueClaimedRecoveryDelivery(
      id,
      {
        payloads: [{ text: "recover exactly once after reconciliation" }],
        completionRetention: BOUNDED_COMPLETION_RETENTION,
      },
      { replyToId: null },
    );
    installUnknownSendResult({ status: "not_sent" });
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      if (!params.deliveryProducerClaimId) {
        throw new Error("recovered provider send must own a fenced producer lease");
      }
      await markDeliveryPlatformSendAttemptStarted(
        id,
        tmpDir(),
        { replyToId: null },
        params.deliveryProducerClaimId,
      );
      return [{ channel: "demo-channel-a", messageId: "fenced-reconciled-message" }];
    });
    const { result } = await runRecovery({ deliver });
    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(deliver).toHaveBeenCalledOnce();
    expect(mockCallRecord(deliver)).toMatchObject({
      deliveryQueueId: id,
      deliveryProducerClaimId: expect.any(String),
    });
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("completed");
  });
  it("acks unknown-after-send entries reconciled as already sent before commit hooks", async () => {
    const { auditEvents, unsubscribe } = captureAuditEvents();
    const id = await enqueueRecoveryDelivery({
      accountId: "acct-1",
      payloads: [{ text: "maybe sent" }],
      reply: { source: "implicit", replyToId: "root-message", mode: "all" },
      threadId: "thread-1",
      silent: true,
      maxRetries: 1,
    });
    await reserveDeliveryAttempt(id, 1, tmpDir());
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), {
      replyToId: "hooked-root-message",
    });
    await markDeliveryPlatformOutcomeUnknown(id, tmpDir());
    const order: string[] = [];
    const afterCommit = vi.fn(() => {
      order.push("afterCommit");
    });
    const reconcileUnknownSend = vi.fn().mockResolvedValue(reconciledSent("platform-1", 1));
    installUnknownSendAdapter(
      reconcileUnknownSend,
      {},
      {
        send: {
          lifecycle: {
            afterCommit,
          },
        },
      },
    );
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });
    unsubscribe();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual(RECOVERY_SUMMARY.recovered);
    const reconcileInput = mockCallRecord(reconcileUnknownSend);
    expect(reconcileInput.cfg).toBe(baseCfg);
    expect(reconcileInput.queueId).toBe(id);
    expect(reconcileInput.channel).toBe("demo-channel-a");
    expect(reconcileInput.to).toBe("+1");
    expect(reconcileInput.accountId).toBe("acct-1");
    expect(reconcileInput.payloads).toEqual([{ text: "maybe sent" }]);
    expect(reconcileInput.replyToId).toBe("root-message");
    expect(reconcileInput.effectiveReplyToId).toBe("hooked-root-message");
    expect(reconcileInput.threadId).toBe("thread-1");
    expect(reconcileInput.silent).toBe(true);
    expect(reconcileInput.retryCount).toBe(0);
    const afterCommitInput = mockCallRecord(afterCommit);
    expect(afterCommitInput.deliveryQueueId).toBe(id);
    expect(afterCommitInput.kind).toBe("text");
    expect(afterCommitInput.to).toBe("+1");
    expect(afterCommitInput.accountId).toBe("acct-1");
    expect(afterCommitInput.replyToId).toBe("hooked-root-message");
    expect(afterCommitInput.threadId).toBe("thread-1");
    expect(afterCommitInput.silent).toBe(true);
    expect((afterCommitInput.result as { messageId?: string })?.messageId).toBe("platform-1");
    expect(order).toEqual(["afterCommit"]);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expectPayloadAudits(auditEvents, id, [
      { status: "succeeded", outcome: "sent", messageId: "platform-1", resultCount: 1 },
    ]);
  });
  it("moves unknown-after-send entries to failed when adapter reports not sent", async () => {
    const id = await enqueueUnknownRecovery({ text: "not sent" });
    installUnknownSendResult({ status: "not_sent" });
    const deliver = vi.fn().mockResolvedValue([]);
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual(RECOVERY_SUMMARY.failed);
    await expectFailedQueue(id);
    expectMockMessageContaining(log.warn, "refusing full replay after post-send evidence");
  });
  it("keeps retryable unresolved unknown-after-send entries on the queue without replaying", async () => {
    const id = await enqueueUnknownRecovery({ text: "unknown" });
    installUnknownSendResult({
      status: "unresolved",
      error: "provider lookup timed out",
      retryable: true,
    });
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });
    expect(deliver).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    const entry = await expectPendingEntry({
      id,
      retryCount: 1,
      recoveryState: "unknown_after_send",
    });
    expect(entry?.lastError).toContain("provider lookup timed out");
  });

  it.each(["recovered", "exhausted", "untyped"] as const)(
    "preserves bounded final-text recovery across storage restart: %s",
    async (outcome) => {
      const id = await enqueueRecoveryDelivery({
        payloads: [{ text: "Saved **final answer**" }],
        retryAmbiguousFinalText: true,
        requiresProducerClaim: true,
      });
      const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
      expect(claimId).toEqual(expect.any(String));
      await reserveDeliveryAttempt(id, 2, tmpDir(), claimId);
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), undefined, claimId);
      await deliveryQueueStorage.failDeliveryAfterPlatformSend(
        id,
        "socket reset",
        tmpDir(),
        claimId,
        undefined,
        outcome === "untyped" ? undefined : true,
      );
      await expectPendingEntry({ id, attemptCount: 1, retryCount: 1 });
      setQueuedEntryState(tmpDir(), id, {
        retryCount: 1,
        lastAttemptAt: Date.now() - 60_000,
      });
      await closeStateDatabaseForTest();
      const transportError = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      const deliver = vi.fn<DeliverFn>(async (params) => {
        await markDeliveryPlatformSendAttemptStarted(
          id,
          tmpDir(),
          undefined,
          params.deliveryProducerClaimId,
        );
        await params.onPlatformSendStart?.({});
        if (outcome === "exhausted") {
          const failure: OutboundPayloadDeliveryOutcome = {
            index: 0,
            status: "failed",
            error: transportError,
            sentBeforeError: true,
            stage: "platform_send",
          };
          params.onPayloadDeliveryOutcome?.(failure);
          throw new OutboundDeliveryError("socket reset", {
            cause: transportError,
            payloadOutcomes: [failure],
            stage: "platform_send",
          });
        }
        return [{ channel: "demo-channel-a", messageId: "recovered-final" }];
      });
      await runRecovery({ deliver });
      expect(deliver).toHaveBeenCalledTimes(outcome === "untyped" ? 0 : 1);
      if (outcome === "exhausted") {
        const pending = await expectPendingEntry({ id, attemptCount: 2, retryCount: 2 });
        expect(pending?.ambiguousTransportError).toBe(true);
        setQueuedEntryState(tmpDir(), id, {
          retryCount: 2,
          lastAttemptAt: Date.now() - 60_000,
        });
      }
      await closeStateDatabaseForTest();
      await runRecovery({ deliver });
      expect(deliver).toHaveBeenCalledTimes(outcome === "untyped" ? 0 : 1);
      expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
    },
  );
  it("dead-letters an exhausted unknown send after retryable reconciliation fails", async () => {
    const artifact = path.join(
      tmpDir(),
      "delivery-queue-media",
      "00000000-0000-4000-8000-000000000099.ogg",
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "private media");
    const oldArtifactTime = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await fs.utimes(artifact, oldArtifactTime, oldArtifactTime);
    const id = await enqueueUnknownRecovery({
      text: "unknown final attempt",
      delivery: {
        maxRetries: 1,
        payloads: [{ text: "unknown final attempt", mediaUrl: artifact }],
      },
      queue: { lastAttemptAt: Date.now() - 10_000_000 },
    });
    await reserveDeliveryAttempt(id, 1, tmpDir());
    const reconcileUnknownSend = vi.fn().mockResolvedValue({
      status: "unresolved",
      error: "provider lookup timed out",
      retryable: true,
    });
    const cleanupStarted = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const afterUnknownSendTerminal = vi.fn(async (ctx: { queueId: string }) => {
      expect(ctx.queueId).toBe(id);
      expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
      await expect(fs.stat(artifact)).resolves.toBeDefined();
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    });
    installUnknownSendAdapter(reconcileUnknownSend, { afterUnknownSendTerminal });
    const deliver = vi.fn().mockResolvedValue([]);
    const recovery = runRecovery({ deliver });
    await cleanupStarted.promise;
    await pruneOrphanedDeliveryQueueMedia({ stateDir: tmpDir() });
    const survivedPausedCleanup = await fs.stat(artifact).then(
      () => true,
      () => false,
    );
    releaseCleanup.resolve();
    const { result } = await recovery;
    expect(survivedPausedCleanup).toBe(true);
    expect(reconcileUnknownSend).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1, skippedMaxRetries: 0 });
    await expectFailedQueue(id);
    expect(afterUnknownSendTerminal).toHaveBeenCalledOnce();
    await expect(fs.stat(artifact)).rejects.toThrow();
  });
  it("terminalizes permanent provider errors without backoff", async () => {
    const id = await enqueueRecoveryDelivery({ channel: "matrix", to: "!room:example" });
    const deliver = vi
      .fn()
      .mockRejectedValue(
        new Error("MatrixError: [403] User @bot:example not in room !room:example"),
      );
    expect((await runRecovery({ deliver })).result).toEqual(RECOVERY_SUMMARY.failed);
    expect(deliver).toHaveBeenCalledOnce();
    await expectFailedQueue(id);
  });
  it("persists a nested channel rejection as the only terminal across recovery restart", async () => {
    const operationId = "operation-channel-permanent-rejection";
    const scope = await createConversationRecoveryFixture(operationId);
    const rejection = new PlatformMessageNotDispatchedError(
      "Slack chat.postMessage rejected: messages_tab_disabled",
      {
        cause: new Error("messages_tab_disabled"),
        retryable: false,
      },
    );
    const deliver = vi.fn().mockRejectedValue(
      new OutboundDeliveryError("Slack delivery failed", {
        cause: rejection,
        payloadOutcomes: [
          {
            index: 0,
            status: "failed",
            error: rejection,
            sentBeforeError: false,
            stage: "platform_send",
          },
        ],
        stage: "platform_send",
      }),
    );

    const first = await runRecovery({ deliver });
    expect(first.result).toEqual(RECOVERY_SUMMARY.failed);
    expect(deliver).toHaveBeenCalledOnce();
    expect(await getConversationDeliveryOperation(scope, operationId)).toMatchObject({
      status: "rejected",
      rejectionError: "Slack chat.postMessage rejected: messages_tab_disabled",
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), operationId)).toBe("failed");

    await closeConversationAgentDatabases();
    const replay = vi.fn();
    const second = await runRecovery({ deliver: replay });
    expect(second.result).toEqual(RECOVERY_SUMMARY.empty);
    expect(replay).not.toHaveBeenCalled();
    expect(await getConversationDeliveryOperation(scope, operationId)).toMatchObject({
      status: "rejected",
      rejectionError: "Slack chat.postMessage rejected: messages_tab_disabled",
    });
    expect(readOutboundQueueStatus(tmpDir(), operationId)).toBe("failed");
  });
  it("does not restore an acked entry when a recovered send commit hook fails", async () => {
    const id = await enqueueRecoveryDelivery();
    const result = attachOutboundDeliveryCommitHook(
      { channel: "demo-channel-a", messageId: "m1" },
      async () => {
        expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
        throw new Error("commit hook offline");
      },
    );
    const deliver = vi.fn().mockResolvedValue([result]);
    const { result: summary } = await runRecovery({ deliver });
    expect(summary).toEqual(RECOVERY_SUMMARY.recovered);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  });
  it.each([
    ["marks a recovered send unknown before ack so ack failure cannot make it replayable", "ack"],
    ["recovers an explicit no-send after ack failure and database reopen", "zero-result-ack"],
    ["directly acks a recovered send when its post-send marker fails", "marker"],
    ["retains unknown-after-send when recovered-send marking and ack both fail", "marker-and-ack"],
  ])("%s", async (_, mode) => {
    const id = await enqueueRecoveryDelivery();
    const markerFails = mode === "marker" || mode === "marker-and-ack";
    const ackFails = mode === "ack" || mode === "zero-result-ack" || mode === "marker-and-ack";
    let recoveryStateAtAck: string | undefined;
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      if (mode !== "zero-result-ack") {
        return [{ channel: "demo-channel-a", messageId: "m1" }];
      }
      await markDeliveryPlatformSendAttemptStarted(
        id,
        tmpDir(),
        undefined,
        params.deliveryProducerClaimId,
      );
      await params.onPlatformSendStart?.({});
      params.onPayloadDeliveryOutcome?.({
        index: 0,
        status: "suppressed",
        reason: "adapter_returned_no_send",
      });
      return [];
    });
    const { summary, log } = await runRecoveryWithStorageOverrides({
      overrides: {
        ...(markerFails
          ? {
              markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
                throw new Error("post-send state db locked");
              }),
            }
          : {}),
        ...(ackFails
          ? {
              ackDelivery: vi.fn(async (entryId: string, stateDir?: string) => {
                recoveryStateAtAck = (
                  await deliveryQueueStorage.loadPendingDelivery(entryId, stateDir)
                )?.recoveryState;
                throw new Error("ack state db locked");
              }),
            }
          : {}),
      },
      deliver,
    });
    if (mode === "marker") {
      expect(summary).toEqual(RECOVERY_SUMMARY.recovered);
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
      expectMockMessageContaining(log.warn, "falling back to direct ack");
      return;
    }
    if (mode === "ack") {
      expect(summary).toEqual(RECOVERY_SUMMARY.failed);
      expect(recoveryStateAtAck).toBe("unknown_after_send");
    } else {
      expect(summary).toMatchObject({ recovered: 0, failed: 1 });
    }
    const pending = await expectPendingEntry({
      id,
      ...(mode === "zero-result-ack" ? {} : { recoveryState: "unknown_after_send" }),
      ...(mode === "ack" ? {} : { retryCount: 1 }),
    });
    await runIf(markerFails, () =>
      expect(pending?.lastError).toContain("marker=post-send state db locked"),
    );
    expect(pending?.lastError).toContain(
      mode === "marker-and-ack" ? "ack=ack state db locked" : "ack state db locked",
    );
    if (mode === "zero-result-ack") {
      expect(recoveryStateAtAck).toBe("send_attempt_started");
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      await closeStateDatabaseForTest();
      const { auditEvents, unsubscribe } = captureAuditEvents();
      try {
        const replay = await runRecovery({ deliver });
        expect(replay.result).toEqual(RECOVERY_SUMMARY.recovered);
        expect(pending?.recoveryState).toBeUndefined();
        expect(pending?.platformSendStartedAt).toBeUndefined();
        expect(pending?.platformSendAttemptId).toBeUndefined();
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
        expectPayloadAudits(auditEvents, id, [
          { outcome: "suppressed", reasonCode: "no_visible_payload", resultCount: 0 },
        ]);
      } finally {
        unsubscribe();
        clock.mockRestore();
      }
    }
  });
  it("retains later media until an early recovery ack finishes the batch", async () => {
    const spoolDir = path.join(tmpDir(), "delivery-queue-media");
    const firstArtifact = path.join(spoolDir, "00000000-0000-4000-8000-000000000001.ogg");
    const secondArtifact = path.join(spoolDir, "00000000-0000-4000-8000-000000000002.ogg");
    await fs.mkdir(spoolDir, { recursive: true });
    await fs.writeFile(firstArtifact, "first-audio");
    await fs.writeFile(secondArtifact, "second-audio");
    const oldArtifactTime = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await fs.utimes(firstArtifact, oldArtifactTime, oldArtifactTime);
    await fs.utimes(secondArtifact, oldArtifactTime, oldArtifactTime);
    await enqueueRecoveryDelivery({
      payloads: [{ mediaUrl: firstArtifact }, { mediaUrl: secondArtifact }],
    });
    const firstResult = { channel: "demo-channel-a", messageId: "m1" };
    const secondResult = { channel: "demo-channel-a", messageId: "m2" };
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      await params.onDeliveryResult?.(firstResult);
      await pruneOrphanedDeliveryQueueMedia({ stateDir: tmpDir() });
      expect(await fs.readFile(secondArtifact, "utf8")).toBe("second-audio");
      await params.onDeliveryResult?.(secondResult);
      return [firstResult, secondResult];
    });
    const { summary } = await runRecoveryWithStorageOverrides({
      overrides: {
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
      },
      deliver,
    });
    expect(summary).toMatchObject({ recovered: 1, failed: 0 });
    await expect(fs.stat(firstArtifact)).rejects.toThrow();
    await expect(fs.stat(secondArtifact)).rejects.toThrow();
  });
  it("owns the stable terminal when recovery fallback ack precedes provider rejection", async () => {
    const { auditEvents, unsubscribe } = captureAuditEvents();
    const id = await enqueueRecoveryDelivery({
      queuePolicy: "best_effort",
      payloads: [{ text: "secret" }],
    });
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      await params.deliveryQueueOwner!.ack();
      reportPayloadFailure(params, new Error("provider rejected send"));
      throw new Error("provider rejected send");
    });
    const { result } = await runRecovery({ deliver });
    unsubscribe();
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expectPayloadAudits(auditEvents, id, [{ outcome: "failed", failureStage: "platform_send" }]);
    expect(JSON.stringify(auditEvents)).not.toContain("secret");
    expect(JSON.stringify(auditEvents)).not.toContain("provider rejected send");
  });
  it("runs recovered commit hooks when marker fallback ack precedes a partial failure", async () => {
    await enqueueRecoveryDelivery({
      payloads: [{ text: "first" }, { text: "second" }],
      bestEffort: true,
    });
    const afterCommit = vi.fn();
    const result = attachOutboundDeliveryCommitHook(
      { channel: "demo-channel-a", messageId: "m1" },
      afterCommit,
    );
    const { summary } = await runRecoveryWithStorageOverrides({
      overrides: {
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
      },
      deliver: vi.fn(
        async (params: {
          onDeliveryResult?: (deliveryResult: typeof result) => Promise<void> | void;
          onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
        }) => {
          await params.onDeliveryResult?.(result);
          params.onPayloadDeliveryOutcome?.({
            index: 1,
            status: "failed",
            error: new Error("second send failed"),
            sentBeforeError: false,
            stage: "platform_send",
          });
          return [result];
        },
      ),
    });
    expect(summary).toMatchObject({ recovered: 0, failed: 1 });
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });
  it("replays live delivery options while retaining legacy mirror data only in storage", async () => {
    const storedOptions = {
      reply: { replyToId: "root-message", source: "implicit", mode: "first" } as const,
      formatting: {
        textLimit: 1234,
        maxLinesPerMessage: 7,
        tableMode: "off",
        chunkMode: "newline",
      },
      bestEffort: true,
      gifPlayback: true,
      silent: true,
      gatewayClientScopes: ["operator.write"],
      mirror: {
        sessionKey: "agent:main:main",
        expectedSessionId: "session-main",
        text: "a",
        mediaUrls: ["https://example.com/a.png"],
        idempotencyKey: "channel-final:message-1",
        deliveryMirror: {
          kind: "channel-final",
          sourceMessageId: "message-1",
        },
      },
      session: {
        key: "agent:main:main",
        agentId: "agent-main",
        requesterAccountId: "acct-1",
        requesterSenderId: "sender-1",
        requesterSenderName: "Sender One",
        requesterSenderUsername: "sender.one",
        requesterSenderE164: "+15551234567",
      },
    } satisfies Partial<Parameters<typeof enqueueDelivery>[0]>;
    const id = await enqueueRecoveryDelivery(storedOptions);
    const legacyEntry = {
      ...readQueuedEntry(tmpDir(), id),
      id,
      enqueuedAt: Date.now(),
      retryCount: 0,
      mirror: storedOptions.mirror,
    };
    seedDeliveryQueueEntry({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      stateDir: tmpDir(),
      entry: legacyEntry,
    });
    const stored = await loadPendingDeliveries(tmpDir());
    expect(stored).toEqual([expect.objectContaining({ id, ...storedOptions })]);
    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });
    const deliverInput = mockCallRecord(deliver);
    const { mirror: _legacyMirror, ...liveOptions } = storedOptions;
    expect(deliverInput).toEqual(expect.objectContaining(liveOptions));
    expect(deliverInput).not.toHaveProperty("mirror");
  });
  it("continues past high-backoff entries and recovers ready entries behind them", async () => {
    const now = Date.now();
    const blockedId = await enqueueRecoveryDelivery({ payloads: [{ text: "blocked" }] });
    const readyId = await enqueueRecoveryDelivery({
      channel: "demo-channel-b",
      to: "2",
      payloads: [{ text: "ready" }],
    });
    setQueuedEntryState(tmpDir(), blockedId, {
      retryCount: 3,
      lastAttemptAt: now,
      enqueuedAt: now - 30_000,
    });
    setQueuedEntryState(tmpDir(), readyId, { retryCount: 0, enqueuedAt: now - 10_000 });
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver, maxRecoveryMs: 60_000 });
    expect(result).toEqual(RECOVERY_SUMMARY.recoveredWithDeferred);
    expect(deliver).toHaveBeenCalledTimes(1);
    const deliverInput = mockCallRecord(deliver);
    expect(deliverInput).toMatchObject({ channel: "demo-channel-b", to: "2", skipQueue: true });
    const remaining = await loadPendingDeliveries(tmpDir());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(blockedId);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
