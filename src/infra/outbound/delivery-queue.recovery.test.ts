import fs from "node:fs/promises";
import path from "node:path";
import { assert, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { resolveDeliveryQueueStateEnv } from "../delivery-queue-state-context.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
  type OutboundPayloadDeliveryOutcome,
  type OutboundDeliveryResult,
} from "./deliver-types.js";
import { attachOutboundDeliveryCommitHook } from "./delivery-commit-hooks.js";
import { pruneOrphanedDeliveryQueueMedia } from "./delivery-queue-media-spool.js";
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
import {
  RECOVERY_SUMMARY,
  loadPendingDeliveries,
  asDeliverFn,
  createRecoveryLog,
  createQueueMedia,
  createPendingFinalFixture,
  installDeliveryQueueTmpDirHooks,
  prepareConversationDelivery,
  readQueuedEntry,
  readQueueStatus as readOutboundQueueStatus,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";
const MAX_RETRIES = 5;
const COMPLETION_RETENTION = {
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
function mockCallRecord(mock: { mock: { calls: unknown[][] } }) {
  const value = mock.mock.calls[0]?.[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected first mock call argument to be a record");
  }
  return value as Record<string, unknown>;
}
function expectMockMessageContaining(mock: { mock: { calls: unknown[][] } }, expected: string) {
  const messages = mock.mock.calls.map((call) => (typeof call[0] === "string" ? call[0] : ""));
  expect(messages.join("\n")).toContain(expected);
}
function captureAuditEvents() {
  const auditEvents: TrustedMessageAuditEvent[] = [];
  const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
  return {
    auditEvents,
    unsubscribe,
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
type SendParams = Parameters<DeliverFn>[0];
type EnqueueParams = Partial<Parameters<typeof enqueueDelivery>[0]>;
type FailedOutcome = Extract<OutboundPayloadDeliveryOutcome, { status: "failed" }>;
function payloadFailure(error: Error, overrides: Partial<FailedOutcome> = {}): FailedOutcome {
  return {
    index: 0,
    status: "failed",
    error,
    sentBeforeError: false,
    stage: "platform_send",
    ...overrides,
  };
}
function reportPayloadFailure(
  params: PayloadOutcomeSink,
  error: Error,
  overrides: Partial<FailedOutcome> = {},
) {
  params.onPayloadDeliveryOutcome?.(payloadFailure(error, overrides));
}
function deliveryFailure(
  message: string,
  error: Error,
  outcomes: OutboundPayloadDeliveryOutcome[] = [payloadFailure(error)],
  results: OutboundDeliveryResult[] = [],
) {
  return new OutboundDeliveryError(message, {
    cause: error,
    payloadOutcomes: outcomes,
    results,
    stage: "platform_send",
  });
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
async function closeConversationAgentDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}
describe("delivery-queue recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  afterEach(closeConversationAgentDatabases);
  const baseCfg = {};
  let deliver: ReturnType<typeof vi.fn>;
  function enqueue(params: EnqueueParams = {}) {
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
  function enqueueOnce(id: string, params: EnqueueParams) {
    return enqueueDeliveryOnce(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "stable delivery" }],
        queuePolicy: "required",
        ...params,
      },
      id,
      tmpDir(),
    );
  }
  function enqueueBatch(texts: string[], params: EnqueueParams = {}) {
    return enqueue({
      channel: "demo-channel-c",
      to: "#ch",
      payloads: texts.map((text) => ({ text })),
      ...params,
    });
  }
  function installReconciler(
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
  function reconcileAs(result: Record<string, unknown>) {
    const reconcileUnknownSend = vi.fn().mockResolvedValue(result);
    installReconciler(reconcileUnknownSend);
    return reconcileUnknownSend;
  }
  async function enqueueUnknown(params: {
    text: string;
    delivery?: EnqueueParams;
    queue?: Record<string, unknown>;
  }) {
    const id = await enqueue({
      payloads: [{ text: params.text }],
      ...params.delivery,
    });
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
      ...params.queue,
    });
    return id;
  }
  async function expectRemoved(id: string) {
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  }
  async function expectPending(expected: Record<string, unknown>) {
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    assert(entry, "Expected one pending entry");
    for (const [key, value] of Object.entries(expected)) {
      expect(Reflect.get(entry, key)).toEqual(value);
    }
    return entries[0];
  }
  async function startSend(id: string, params: SendParams, claim = false) {
    await markDeliveryPlatformSendAttemptStarted(
      id,
      tmpDir(),
      undefined,
      claim ? params.deliveryProducerClaimId : undefined,
    );
    await params.onPlatformSendStart?.({});
  }
  async function suppressSend(id: string, params: SendParams) {
    await startSend(id, params, true);
    params.onPayloadDeliveryOutcome?.({
      index: 0,
      status: "suppressed",
      reason: "adapter_returned_no_send",
    });
    return [];
  }
  async function oldMedia(id: string, content: string) {
    const artifact = await createQueueMedia(tmpDir(), id.padStart(12, "0"), content);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await fs.utimes(artifact, old, old);
    return artifact;
  }
  async function enqueueClaimed(
    id: string,
    delivery: Partial<Parameters<typeof enqueueDeliveryOnce>[0]>,
    route?: { replyToId: string | null },
  ) {
    await enqueueOnce(id, delivery);
    const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
    assert(claimId, "test invariant: stable delivery must own its platform attempt");
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), route, claimId);
    return claimId;
  }
  beforeEach(() => {
    deliver = vi.fn().mockResolvedValue([]);
    resolveOutboundChannelMessageAdapterMock.mockReset();
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
  });
  const enqueueCrashRecoveryEntries = async () => {
    await enqueue({
      preparedMessageId: "prepared-message-a",
    });
    await enqueue({
      channel: "demo-channel-b",
      to: "2",
      payloads: [{ text: "b" }],
      queuePolicy: "required",
      requireUnknownSendReconciliation: true,
    });
  };
  const recover = async ({
    deliver: send,
    log = createRecoveryLog(),
    maxRecoveryMs,
  }: {
    deliver: ReturnType<typeof vi.fn>;
    log?: ReturnType<typeof createRecoveryLog>;
    maxRecoveryMs?: number;
  }) => {
    const result = await recoverPendingDeliveries({
      deliver: asDeliverFn(send),
      log,
      cfg: baseCfg,
      stateDir: tmpDir(),
      ...(maxRecoveryMs === undefined ? {} : { maxRecoveryMs }),
    });
    return { result, log };
  };
  function finalSessionScope(completion: { sessionKey: string; storePath: string }) {
    return { ...completion, env: resolveDeliveryQueueStateEnv(tmpDir()) };
  }
  async function replaceWriter(completion: { sessionKey: string; storePath: string }) {
    const scope = finalSessionScope(completion);
    const current = loadSessionEntry(scope);
    assert(current, "Expected pending-final recovery session");
    await replaceSessionEntry(scope, {
      ...current,
      activeWriterRunId: "replacement-writer",
      lifecycleRevision: "replacement-revision",
      updatedAt: Date.now(),
    });
  }
  async function recoverWithFaults(params: {
    markerFails: boolean;
    ack?: typeof deliveryQueueStorage.ackDelivery;
    deliver: ReturnType<typeof vi.fn>;
  }) {
    const ackSpy = params.ack
      ? vi.spyOn(deliveryQueueStorage, "ackDelivery").mockImplementation(params.ack)
      : undefined;
    const markerSpy = params.markerFails
      ? vi
          .spyOn(deliveryQueueStorage, "markDeliveryPlatformOutcomeUnknown")
          .mockRejectedValue(new Error("post-send state db locked"))
      : undefined;
    try {
      const { result, log } = await recover({ deliver: params.deliver });
      return { summary: result, log };
    } finally {
      ackSpy?.mockRestore();
      markerSpy?.mockRestore();
    }
  }
  async function conversation(operationId: string) {
    const storePath = path.join(tmpDir(), "agent-sessions.json");
    const scope = {
      agentId: "main",
      storePath,
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    };
    const delivery = await prepareConversationDelivery(
      scope,
      operationId,
      "hello",
      "route-recovery",
    );
    await enqueueOnce(operationId, delivery);
    return scope;
  }
  async function pendingFinal(deliveryId: string, withWriterAuthority = false) {
    const sessionKey = "agent:main:demo-channel-a:direct:pending-final";
    const storePath = path.join(tmpDir(), "pending-final-sessions.json");
    const lifecycleRevision = "pending-final-recovery-revision";
    const writerRunId = "pending-final-recovery-writer";
    const context = { channel: "demo-channel-a", to: "+1" };
    const text = "recovered delivery identity may have been lost";
    const { completion: base, entry } = createPendingFinalFixture(
      storePath,
      deliveryId,
      sessionKey,
      {
        context,
        text,
        now: Date.now(),
      },
    );
    const completion = {
      ...base,
      ...(withWriterAuthority
        ? {
            sessionWriterDeliveryAuthority: {
              agentId: "main",
              expectedLifecycleRevision: lifecycleRevision,
              expectedSessionId: base.sessionId,
              expectedWriterRunId: writerRunId,
              sessionKey,
              storePath,
            },
          }
        : {}),
    };
    await replaceSessionEntry(
      { sessionKey, storePath, env: resolveDeliveryQueueStateEnv(tmpDir()) },
      {
        ...entry,
        ...(withWriterAuthority ? { activeWriterRunId: writerRunId, lifecycleRevision } : {}),
      },
    );
    await enqueueOnce(deliveryId, {
      maxRetries: 1,
      payloads: [{ text }],
      deliveryCompletion: completion,
    });
    return { completion, context };
  }
  it("finalizes a persisted conversation operation during queue recovery", async () => {
    const scope = await conversation("operation-recovery");
    const deliveryResult = { channel: "reef" as const, messageId: "reef-platform" };
    deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
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
    const { result, log } = await recover({ deliver });
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
    const scope = await conversation(operationId);
    const { auditEvents } = captureAuditEvents();
    deliver = vi.fn((params: SendParams) => suppressSend(operationId, params));
    const first = await recover({ deliver });
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
    const second = await recover({ deliver });
    expect(second.result).toEqual(RECOVERY_SUMMARY.empty);
    expect(deliver).toHaveBeenCalledOnce();
    expect((await getConversationDeliveryOperation(scope, operationId))?.status).toBe("suppressed");
    expect(auditEvents).toHaveLength(1);
  });
  it.each([undefined, "adapter_returned_no_identity"] as const)(
    "keeps an uncertainty notice owed when recovery returns no delivery identity (%s)",
    async (reason) => {
      const deliveryId = "pending-final-unknown-recovery";
      const { completion, context } = await pendingFinal(deliveryId);
      const { auditEvents, unsubscribe } = captureAuditEvents();
      deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
        expect(params.deliveryCompletion).toBeUndefined();
        await startSend(deliveryId, params);
        if (reason) {
          params.onPayloadDeliveryOutcome?.({ index: 0, status: "suppressed", reason });
        }
        return [];
      });
      const { result } = await recover({ deliver });

      expect(loadSessionEntry(finalSessionScope(completion))).toMatchObject({
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
      await expectPending({
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
      const second = await recover({ deliver });
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
  it.each(["onDirectAdapterHandoff", "onPlatformSendDispatch", "afterHandoff"] as const)(
    "rejects a recovered pending final with a stale writer at %s",
    async (transportBoundary) => {
      const deliveryId = `pending-final-stale-recovery-${transportBoundary}`;
      const { completion } = await pendingFinal(deliveryId, true);
      if (transportBoundary !== "afterHandoff") {
        await replaceWriter(completion);
      }
      const platformSend = vi.fn();
      deliver = vi.fn(async (params: SendParams) => {
        if (transportBoundary === "afterHandoff") {
          await params.onDirectAdapterHandoff?.();
          await replaceWriter(completion);
          params.assertDirectAdapterHandoff?.();
        } else {
          await params[transportBoundary]?.();
        }
        await platformSend();
        return [];
      });
      const { result } = await recover({ deliver });

      expect(deliver).toHaveBeenCalledOnce();
      expect(platformSend).not.toHaveBeenCalled();
      expect(result).toEqual(RECOVERY_SUMMARY.failed);
    },
  );
  it.each(["suppressed", "rejected", "sent"] as const)(
    "acks a persisted %s conversation operation without replaying it",
    async (state) => {
      const rejected = state === "rejected";
      const operationId = `operation-${state}`;
      const scope = await conversation(operationId);
      if (rejected) {
        await markConversationDeliveryRejected(scope, operationId, "atomic message limit");
      } else if (state === "suppressed") {
        await markConversationDeliverySuppressed(scope, operationId);
      } else {
        await markConversationDeliverySent(scope, operationId, "reef-platform");
      }
      deliver = vi.fn();
      await closeConversationAgentDatabases();
      await closeStateDatabaseForTest();
      const { auditEvents } = captureAuditEvents();
      const { result } = await recover({ deliver });
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
      expect((await recover({ deliver })).result).toEqual(RECOVERY_SUMMARY.empty);
      expect(auditEvents).toHaveLength(1);
    },
  );
  it("rejects blocked rows before backoff or reconciliation", async () => {
    const { auditEvents } = captureAuditEvents();
    const id = await enqueue({
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
    deliver = vi.fn();
    expect((await recover({ deliver })).result).toEqual(RECOVERY_SUMMARY.failed);
    expect(reconcileUnknownSend).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
    expectPayloadAudits(auditEvents, id, [
      { status: "unknown", outcome: "unknown", failureStage: "queue" },
    ]);
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: { admitDeferredDelivery: () => ({ status: "allowed" }) },
    });
    await recover({ deliver });
    expect(deliver).not.toHaveBeenCalled();
  });
  it("counts replay pacing against the recovery budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
    try {
      const controlledSleep = controlNextRecoverySleep(sleepMock);
      await enqueueCrashRecoveryEntries();
      await enqueueBatch(["c"]);
      const recovery = recover({ deliver, maxRecoveryMs: 1 });
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
      const id = await enqueue({ maxRetries });
      setQueuedEntryState(tmpDir(), id, { retryCount, lastAttemptAt: Date.now() - 10_000_000 });
      expect((await recover({ deliver })).result).toMatchObject({
        recovered: 1,
        skippedMaxRetries: 0,
      });
      expect(deliver).toHaveBeenCalledOnce();
      expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
    },
  );
  it("dead-letters max-retry entries even when conversation owner state is missing", async () => {
    const storePath = path.join(tmpDir(), "missing-owner-sessions.json");
    const id = await enqueue({
      deliveryCompletion: {
        kind: "conversation",
        agentId: "main",
        operationId: "missing-operation",
        storePath,
      },
    });
    setQueuedEntryState(tmpDir(), id, { retryCount: MAX_RETRIES });
    const log = createRecoveryLog();
    const { result } = await recover({ deliver: vi.fn(), log });
    expect(result.skippedMaxRetries).toBe(1);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("settlement");
  });
  it("keeps a partially sent batch unknown when a later send has a permanent rejection", async () => {
    const id = await enqueueBatch(["first", "second"]);
    const rejection = new PlatformMessageNotDispatchedError(
      "Slack outbound delivery rejected: messages_tab_disabled",
      { cause: new Error("messages_tab_disabled"), retryable: false },
    );
    const results = [{ channel: "demo-channel-c" as const, messageId: "m1" }];
    const partialFailure = deliveryFailure(
      "second send failed",
      rejection,
      [{ index: 0, status: "sent", results }, payloadFailure(rejection, { index: 1 })],
      results,
    );
    const { result } = await recover({
      deliver: vi.fn().mockRejectedValue(partialFailure),
    });
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    await expectPending({ id, recoveryState: "unknown_after_send", retryCount: 0 });
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("pending");
    const replay = vi.fn();
    await recover({ deliver: replay });
    expect(replay).not.toHaveBeenCalled();
    await expectRemoved(id);
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
      const id = await enqueueBatch(texts, { bestEffort: true });
      deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
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
      const { result } = await recover({ deliver });
      expect(result).toMatchObject({ recovered: 0, failed: 1 });
      if (state === "terminal") {
        await expectRemoved(id);
        return;
      }
      const recoveryState = state === "unmarked" ? undefined : state;
      const entry = await expectPending({
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
    const id = await enqueueBatch(["first", "second"], { bestEffort: true });
    deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      await startSend(id, params);
      reportPayloadFailure(params, new Error("second send failed"), {
        index: 1,
        sentBeforeError: true,
      });
      return [];
    });
    const { result } = await recover({ deliver });
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    await expectPending({ id, recoveryState: "unknown_after_send", retryCount: 0 });
    const replay = vi.fn();
    await recover({ deliver: replay });
    expect(replay).not.toHaveBeenCalled();
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  });
  it("reconciles an unknown stable send after restart recovery waits for its lease expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
    try {
      const id = "cron-direct-delivery:v1:restart-before-producer-lease-expiry";
      const originalClaimId = await enqueueClaimed(id, {
        completionRetention: COMPLETION_RETENTION,
        requiresProducerClaim: true,
      });
      await markDeliveryPlatformOutcomeUnknown(id, tmpDir(), originalClaimId);
      const leaseExpiry = (await loadPendingDeliveries(tmpDir()))[0]?.availableAt;
      if (leaseExpiry === undefined) {
        throw new Error("test invariant: the stable producer claim must have an expiry");
      }
      const reconcileUnknownSend = reconcileAs(
        reconciledSent("reconciled-after-expiry", leaseExpiry),
      );
      deliver = vi.fn();
      const firstRun = await recover({ deliver });
      expect(firstRun.result).toMatchObject({
        recovered: 0,
        failed: 0,
      });
      expect(reconcileUnknownSend).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      vi.setSystemTime(leaseExpiry + 1);
      const secondRun = await recover({ deliver });
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
    await enqueueClaimed(
      id,
      {
        payloads: [{ text: "recover exactly once after reconciliation" }],
        completionRetention: COMPLETION_RETENTION,
      },
      { replyToId: null },
    );
    reconcileAs({ status: "not_sent" });
    deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
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
    const { result } = await recover({ deliver });
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
    const id = await enqueue({
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
    installReconciler(
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
    const { result } = await recover({ deliver });
    unsubscribe();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual(RECOVERY_SUMMARY.recovered);
    const reconcileInput = mockCallRecord(reconcileUnknownSend);
    expect(reconcileInput.cfg).toBe(baseCfg);
    expect(reconcileInput.payloads).toEqual([{ text: "maybe sent" }]);
    const route = { to: "+1", accountId: "acct-1", threadId: "thread-1", silent: true };
    expect(reconcileInput).toMatchObject({
      ...route,
      queueId: id,
      channel: "demo-channel-a",
      replyToId: "root-message",
      effectiveReplyToId: "hooked-root-message",
      retryCount: 0,
    });
    expect(mockCallRecord(afterCommit)).toMatchObject({
      ...route,
      deliveryQueueId: id,
      kind: "text",
      replyToId: "hooked-root-message",
      result: { messageId: "platform-1" },
    });
    expect(order).toEqual(["afterCommit"]);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expectPayloadAudits(auditEvents, id, [
      { status: "succeeded", outcome: "sent", messageId: "platform-1", resultCount: 1 },
    ]);
  });
  it("moves unknown-after-send entries to failed when adapter reports not sent", async () => {
    const id = await enqueueUnknown({ text: "not sent" });
    reconcileAs({ status: "not_sent" });
    const log = createRecoveryLog();
    const { result } = await recover({ deliver, log });
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual(RECOVERY_SUMMARY.failed);
    await expectRemoved(id);
    expectMockMessageContaining(log.warn, "refusing full replay after post-send evidence");
  });
  it("keeps retryable unresolved unknown-after-send entries on the queue without replaying", async () => {
    const id = await enqueueUnknown({ text: "unknown" });
    reconcileAs({
      status: "unresolved",
      error: "provider lookup timed out",
      retryable: true,
    });
    const { result } = await recover({ deliver });
    expect(deliver).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    await expectPending({
      id,
      retryCount: 1,
      recoveryState: "unknown_after_send",
      lastError: expect.stringContaining("provider lookup timed out"),
    });
  });

  it.each([
    ["permanent", "chat not found", undefined],
    ["transient", "provider lookup timed out", 1],
  ] as const)(
    "classifies a thrown %s unknown-send reconciliation with the delivery error policy",
    async (_kind, error, retryCount) => {
      const id = await enqueueUnknown({ text: "unknown" });
      const reconcileUnknownSend = vi.fn().mockRejectedValue(new Error(error));
      installReconciler(reconcileUnknownSend);
      const { result } = await recover({ deliver });
      expect(reconcileUnknownSend).toHaveBeenCalledOnce();
      expect(deliver).not.toHaveBeenCalled();
      expect(result.failed).toBe(1);
      if (retryCount === undefined) {
        await expectRemoved(id);
      } else {
        await expectPending({ id, retryCount, recoveryState: "unknown_after_send" });
      }
    },
  );

  it.each(["recovered", "exhausted", "untyped"] as const)(
    "preserves bounded final-text recovery across storage restart: %s",
    async (outcome) => {
      const id = await enqueue({
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
      await expectPending({ id, attemptCount: 1, retryCount: 1 });
      setQueuedEntryState(tmpDir(), id, {
        retryCount: 1,
        lastAttemptAt: Date.now() - 60_000,
      });
      await closeStateDatabaseForTest();
      const transportError = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      deliver = vi.fn<DeliverFn>(async (params) => {
        await startSend(id, params, true);
        if (outcome === "exhausted") {
          const failure = payloadFailure(transportError, { sentBeforeError: true });
          params.onPayloadDeliveryOutcome?.(failure);
          throw deliveryFailure("socket reset", transportError, [failure]);
        }
        return [{ channel: "demo-channel-a", messageId: "recovered-final" }];
      });
      await recover({ deliver });
      expect(deliver).toHaveBeenCalledTimes(outcome === "untyped" ? 0 : 1);
      if (outcome === "exhausted") {
        const pending = await expectPending({ id, attemptCount: 2, retryCount: 2 });
        expect(pending?.ambiguousTransportError).toBe(true);
        setQueuedEntryState(tmpDir(), id, {
          retryCount: 2,
          lastAttemptAt: Date.now() - 60_000,
        });
      }
      await closeStateDatabaseForTest();
      await recover({ deliver });
      expect(deliver).toHaveBeenCalledTimes(outcome === "untyped" ? 0 : 1);
      expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
    },
  );
  it("dead-letters an exhausted unknown send after retryable reconciliation fails", async () => {
    const artifact = await oldMedia("99", "private media");
    const id = await enqueueUnknown({
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
    installReconciler(reconcileUnknownSend, { afterUnknownSendTerminal });
    const recovery = recover({ deliver });
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
    await expectRemoved(id);
    expect(afterUnknownSendTerminal).toHaveBeenCalledOnce();
    await expect(fs.stat(artifact)).rejects.toThrow();
  });
  it("terminalizes permanent provider errors without backoff", async () => {
    const id = await enqueue({ channel: "matrix", to: "!room:example" });
    deliver = vi
      .fn()
      .mockRejectedValue(
        new Error("MatrixError: [403] User @bot:example not in room !room:example"),
      );
    expect((await recover({ deliver })).result).toEqual(RECOVERY_SUMMARY.failed);
    expect(deliver).toHaveBeenCalledOnce();
    await expectRemoved(id);
  });
  it("persists a nested channel rejection as the only terminal across recovery restart", async () => {
    const operationId = "operation-channel-permanent-rejection";
    const scope = await conversation(operationId);
    const rejection = new PlatformMessageNotDispatchedError(
      "Slack chat.postMessage rejected: messages_tab_disabled",
      {
        cause: new Error("messages_tab_disabled"),
        retryable: false,
      },
    );
    deliver = vi.fn().mockRejectedValue(deliveryFailure("Slack delivery failed", rejection));
    const first = await recover({ deliver });
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
    const second = await recover({ deliver: replay });
    expect(second.result).toEqual(RECOVERY_SUMMARY.empty);
    expect(replay).not.toHaveBeenCalled();
    expect(await getConversationDeliveryOperation(scope, operationId)).toMatchObject({
      status: "rejected",
      rejectionError: "Slack chat.postMessage rejected: messages_tab_disabled",
    });
    expect(readOutboundQueueStatus(tmpDir(), operationId)).toBe("failed");
  });
  it("does not restore an acked entry when a recovered send commit hook fails", async () => {
    const id = await enqueue();
    const result = attachOutboundDeliveryCommitHook(
      { channel: "demo-channel-a", messageId: "m1" },
      async () => {
        expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
        throw new Error("commit hook offline");
      },
    );
    deliver = vi.fn().mockResolvedValue([result]);
    const { result: summary } = await recover({ deliver });
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
    const id = await enqueue();
    const markerFails = mode === "marker" || mode === "marker-and-ack";
    const ackFails = mode === "ack" || mode === "zero-result-ack" || mode === "marker-and-ack";
    let recoveryStateAtAck: string | undefined;
    deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      if (mode !== "zero-result-ack") {
        return [{ channel: "demo-channel-a", messageId: "m1" }];
      }
      return suppressSend(id, params);
    });
    const { summary, log } = await recoverWithFaults({
      markerFails,
      ack: ackFails
        ? async (entryId, stateDir) => {
            recoveryStateAtAck = (await deliveryQueueStorage.loadPendingDelivery(entryId, stateDir))
              ?.recoveryState;
            throw new Error("ack state db locked");
          }
        : undefined,
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
    const pending = await expectPending({
      id,
      ...(mode === "zero-result-ack" ? {} : { recoveryState: "unknown_after_send" }),
      ...(mode === "ack" ? {} : { retryCount: 1 }),
    });
    if (markerFails) {
      expect(pending?.lastError).toContain("marker=post-send state db locked");
    }
    expect(pending?.lastError).toContain(
      mode === "marker-and-ack" ? "ack=ack state db locked" : "ack state db locked",
    );
    if (mode === "zero-result-ack") {
      expect(recoveryStateAtAck).toBe("send_attempt_started");
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      await closeStateDatabaseForTest();
      const { auditEvents, unsubscribe } = captureAuditEvents();
      try {
        const replay = await recover({ deliver });
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
    const firstArtifact = await oldMedia("1", "first-audio");
    const secondArtifact = await oldMedia("2", "second-audio");
    await enqueue({
      payloads: [{ mediaUrl: firstArtifact }, { mediaUrl: secondArtifact }],
    });
    const firstResult = { channel: "demo-channel-a", messageId: "m1" };
    const secondResult = { channel: "demo-channel-a", messageId: "m2" };
    deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      await params.onDeliveryResult?.(firstResult);
      await pruneOrphanedDeliveryQueueMedia({ stateDir: tmpDir() });
      expect(await fs.readFile(secondArtifact, "utf8")).toBe("second-audio");
      await params.onDeliveryResult?.(secondResult);
      return [firstResult, secondResult];
    });
    const { summary } = await recoverWithFaults({
      markerFails: true,
      deliver,
    });
    expect(summary).toMatchObject({ recovered: 1, failed: 0 });
    await expect(fs.stat(firstArtifact)).rejects.toThrow();
    await expect(fs.stat(secondArtifact)).rejects.toThrow();
  });
  it("owns the stable terminal when recovery fallback ack precedes provider rejection", async () => {
    const { auditEvents, unsubscribe } = captureAuditEvents();
    const id = await enqueue({
      queuePolicy: "best_effort",
      payloads: [{ text: "secret" }],
    });
    deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      await params.deliveryQueueOwner!.ack();
      reportPayloadFailure(params, new Error("provider rejected send"));
      throw new Error("provider rejected send");
    });
    const { result } = await recover({ deliver });
    unsubscribe();
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expectPayloadAudits(auditEvents, id, [{ outcome: "failed", failureStage: "platform_send" }]);
    expect(JSON.stringify(auditEvents)).not.toContain("secret");
    expect(JSON.stringify(auditEvents)).not.toContain("provider rejected send");
  });
  it("runs recovered commit hooks when marker fallback ack precedes a partial failure", async () => {
    await enqueue({
      payloads: [{ text: "first" }, { text: "second" }],
      bestEffort: true,
    });
    const afterCommit = vi.fn();
    const result = attachOutboundDeliveryCommitHook(
      { channel: "demo-channel-a", messageId: "m1" },
      afterCommit,
    );
    const { summary } = await recoverWithFaults({
      markerFails: true,
      deliver: vi.fn(async (params: SendParams) => {
        await params.onDeliveryResult?.(result);
        reportPayloadFailure(params, new Error("second send failed"), { index: 1 });
        return [result];
      }),
    });
    expect(summary).toMatchObject({ recovered: 0, failed: 1 });
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });
  it("replays stored delivery options during recovery", async () => {
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
    await enqueue(storedOptions);
    await recover({ deliver });
    const deliverInput = mockCallRecord(deliver);
    expect(deliverInput).toEqual(expect.objectContaining(storedOptions));
    // Retained legacy mirror metadata never selects destination history on replay.
    expect(deliverInput).not.toHaveProperty("mirror");
  });
  it("continues past high-backoff entries and recovers ready entries behind them", async () => {
    const now = Date.now();
    const blockedId = await enqueue({ payloads: [{ text: "blocked" }] });
    const readyId = await enqueue({
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
    const { result } = await recover({ deliver, maxRecoveryMs: 60_000 });
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
