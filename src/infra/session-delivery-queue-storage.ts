// Persists queued session deliveries for retry and recovery.
import path from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionPostCompactionDelegate } from "../config/sessions/types.js";
import {
  assertExpectedExistingSession,
  ExpectedExistingSessionChangedError,
} from "../gateway/server-methods/agent-expected-session.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  captureSessionTarget,
  beginSessionEffect,
} from "../sessions/session-controller.lifecycle.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { formatContinuationChildRunId } from "../shared/continuation-run-key.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { sha256Hex } from "./crypto-digest.js";
import { bindDeliveryQueueEntry } from "./delivery-queue-sqlite-bound.js";
import type { DeliveryQueueEntryLoadResult } from "./delivery-queue-sqlite-codec.js";
import {
  inspectDeliveryQueueReceipt,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.js";
import { captureDeliveryQueueStateContext } from "./delivery-queue-state-context.js";
import { generateSecureUuid } from "./secure-random.js";
import { scrubTerminalQueuedAttachments } from "./session-delivery-queue-attachment-metadata.js";
import {
  decodeSessionDeliveryResult,
  normalizeQueuedSessionDeliveryTraceparent,
  normalizeSessionDeliveryForPersistence,
  type QueuedSessionDelivery as CoreQueuedSessionDelivery,
  type SessionDeliveryContext,
  type SessionDeliverySettledOutcome,
} from "./session-delivery-queue-codec.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  SessionDeliveryAcknowledgementFinalizeError,
  SessionDeliveryAttemptStartError,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  SessionDeliverySafeRetryError,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
} from "./session-delivery-queue.records.js";
import type { SessionDeliveryWorkerOperations } from "./session-delivery-queue.worker.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";

/** Queue publication and continuation deletion share the existing session lifecycle owner. */
export async function withSessionDeliveryEnqueueAdmission<T>(
  payload: QueuedSessionDeliveryPayload,
  context: OpenClawStateWorkerContext,
  run: (assertCurrent: () => void) => T | Promise<T>,
): Promise<T> {
  const binding =
    payload.kind === "agentTurn" && payload.requesterBinding
      ? { ...payload.requesterBinding }
      : undefined;
  const sessionKey = payload.sessionKey;
  const unavailable = "session delivery original requester is no longer available";
  const assertQueueCurrent = () => {
    context.admission.assertCurrent();
    if (
      binding &&
      path.resolve(binding.storePath) !==
        path.resolve(
          resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
            agentId: binding.agentId,
            env: context.environment,
          }),
        )
    ) {
      throw new SessionDeliveryDeadLetteredError(unavailable);
    }
  };
  assertQueueCurrent();
  if (!binding && !parseCronRunScopeSuffix(sessionKey).runId) {
    return await run(assertQueueCurrent);
  }
  if (binding && binding.sessionKey !== sessionKey) {
    throw new SessionDeliveryDeadLetteredError(unavailable);
  }
  const agentId = binding?.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const storePath =
    binding?.storePath ??
    resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
      agentId,
      env: context.environment,
    });
  const scope = {
    agentId,
    storePath,
    sessionKey,
    env: context.environment,
    hydrateSkillPromptRefs: false,
  };
  const readEntry = () =>
    withSessionEntryReadOnlyInWorker(scope, assertQueueCurrent, async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      if (!read.value) {
        throw new SessionDeliveryDeadLetteredError(unavailable);
      }
      return read.value;
    });
  const original = await readEntry();
  const constraint = binding ?? {
    sessionId: original.sessionId,
    lifecycleRevision: original.lifecycleRevision ?? null,
  };
  let interruption: Error | undefined;
  let lease: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
  try {
    lease = await beginSessionEffect({
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey,
        incarnation: constraint.sessionId,
        agentId,
      }),
      assertAllowed: async (signal) => {
        signal.throwIfAborted();
        assertExpectedExistingSession({
          constraint,
          entry: await readEntry(),
          message: unavailable,
        });
      },
      onInterrupt(reason) {
        interruption = reason ?? new Error("session delivery admission interrupted");
      },
    });
    const assertCurrent = () => {
      assertQueueCurrent();
      if (interruption) {
        throw interruption;
      }
      if (!lease?.isActive()) {
        throw new Error("session delivery admission closed");
      }
    };
    return await lease.run(async () => await run(assertCurrent));
  } catch (error) {
    if (error instanceof ExpectedExistingSessionChangedError) {
      throw new SessionDeliveryDeadLetteredError(unavailable);
    }
    throw error;
  } finally {
    lease?.release();
  }
}

export type {
  ContinuationReturnWake,
  SessionDeliveryContext,
  SessionDeliveryRoute,
  SessionDeliverySettledOutcome,
} from "./session-delivery-queue-codec.js";

export {
  SESSION_DELIVERY_QUEUE_NAME,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  SessionDeliverySafeRetryError,
};

export type { QueuedSessionDelivery, QueuedSessionDeliveryPayload };

function executeSessionDelivery<Key extends keyof SessionDeliveryWorkerOperations>(
  context: OpenClawStateWorkerContext,
  command: { type: Key; input: SessionDeliveryWorkerOperations[Key]["input"] },
): Promise<SessionDeliveryWorkerOperations[Key]["output"]> {
  // A settled write remains authoritative if its captured owner closes while returning the result.
  return runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command));
}

function prepareEntry(
  entry: QueuedSessionDelivery,
  mode: "insert" | "update",
): ReturnType<typeof bindDeliveryQueueEntry> {
  // Preserve the JSON persistence boundary before the transport serializes its input.
  return bindDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry,
    ...(mode === "insert" ? { insertOnly: true } : { updatePendingOnly: true }),
  });
}

async function failInvalidSessionDelivery(
  params: SessionDeliveryWorkerOperations["sessionDelivery.failInvalid"]["input"] & {
    context: OpenClawStateWorkerContext;
  },
): Promise<void> {
  await executeSessionDelivery(params.context, {
    type: "sessionDelivery.failInvalid",
    input: {
      entry: params.entry,
      error: params.error,
      entryJson: params.entryJson,
    },
  });
}

type SessionDeliveryStorageEnvelope = { retainOnFailure?: true; agentId?: string };

function splitSessionDeliveryStorageEnvelope(entry: DeliveryQueueEntryState): {
  coreEntry: DeliveryQueueEntryState;
  envelope: SessionDeliveryStorageEnvelope;
} {
  const kind = "kind" in entry ? entry.kind : undefined;
  const agentId = "agentId" in entry ? entry.agentId : undefined;
  const coreEntry: Record<string, unknown> = { ...entry };
  const envelope: SessionDeliveryStorageEnvelope = {};
  if (kind === "systemEvent" && typeof agentId === "string" && agentId.trim().length > 0) {
    envelope.agentId = agentId;
    delete coreEntry.agentId;
  } else if (kind === "systemEvent" && agentId === undefined) {
    delete coreEntry.agentId;
  }
  if (entry.retainOnFailure === true) {
    envelope.retainOnFailure = true;
    delete coreEntry.retainOnFailure;
  } else if (entry.retainOnFailure === undefined) {
    delete coreEntry.retainOnFailure;
  }
  // SAFETY: coreEntry only ever drops the two optional agentId/retainOnFailure keys from a spread of entry, so it stays a valid DeliveryQueueEntryState.
  return { coreEntry: coreEntry as DeliveryQueueEntryState, envelope };
}

function normalizeSessionDeliveryForStorage(entry: QueuedSessionDelivery): QueuedSessionDelivery {
  const { coreEntry, envelope } = splitSessionDeliveryStorageEnvelope(entry);
  // SAFETY: callers only ever pass a coreEntry split from a QueuedSessionDelivery, so it always has the kind/sessionKey shape of CoreQueuedSessionDelivery.
  const normalized = normalizeSessionDeliveryForPersistence(coreEntry as CoreQueuedSessionDelivery);
  return { ...normalized, ...envelope };
}

function decodeStoredSessionDeliveryResult(result: DeliveryQueueEntryLoadResult) {
  if (result.status === "corrupt") {
    return decodeSessionDeliveryResult(result);
  }
  const { coreEntry, envelope } = splitSessionDeliveryStorageEnvelope(result.entry);
  const decoded = decodeSessionDeliveryResult({ ...result, entry: coreEntry });
  return decoded.status === "loaded"
    ? { status: "loaded" as const, entry: { ...decoded.entry, ...envelope } }
    : decoded;
}

// Strip trailing whitespace per line and at end-of-string before hashing the
// idempotency key, so same-intent keys that differ only by trailing whitespace
// produce the same sha256 taskHash and the replay-dedupe path stays robust.
function canonicalizeIdempotencyKey(key: string): string {
  return key.replace(/[ \t\r\f\v]+(?=\n|$)/g, "").replace(/\s+$/, "");
}

export function prepareClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  now = Date.now(),
): QueuedSessionDelivery {
  const payload = normalizeQueuedSessionDeliveryTraceparent(params);
  return normalizeSessionDeliveryForStorage({
    ...payload,
    retainOnFailure: true,
    id: buildEntryId(payload.idempotencyKey),
    enqueuedAt: now,
    retryCount: 0,
    availableAt: now + Math.max(0, initialAttemptLeaseMs),
  });
}

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return sha256Hex(canonicalizeIdempotencyKey(idempotencyKey));
}

function buildPostCompactionDelegateIdempotencyKey(params: {
  sessionKey: string;
  delegate: SessionPostCompactionDelegate;
  sequence: number;
  compactionCount?: number;
}): string {
  const taskHash = sha256Hex(params.delegate.task).slice(0, 16);
  return [
    "post-compaction-delegate",
    params.sessionKey,
    String(params.compactionCount ?? "unknown"),
    String(params.delegate.firstArmedAt ?? params.delegate.createdAt),
    String(params.sequence),
    taskHash,
  ].join(":");
}

/**
 * The compaction count of the release that queued a post-compaction entry, read
 * back from the idempotency key `buildPostCompactionDelegateIdempotencyKey` gave
 * it. Older builds persist the same key, so the release join adds no payload
 * field that their strict reader would dead-letter after a rollback. Undefined
 * when the release had no count or the key has another shape.
 */
export function readPostCompactionDelegateReleaseCount(entry: {
  idempotencyKey?: string;
}): number | undefined {
  // The session key can contain ":", so read the count from the end:
  // `...:<compactionCount>:<firstArmedAt>:<sequence>:<taskHash>`.
  const parts = entry.idempotencyKey?.split(":") ?? [];
  const count = parts.at(-4);
  return parts[0] === "post-compaction-delegate" && parts.length >= 6 && /^\d+$/.test(count ?? "")
    ? Number(count)
    : undefined;
}

export function buildPostCompactionDelegateDeliveryPayload(params: {
  sessionKey: string;
  sourceSessionId?: string;
  sourceLifecycleRevision?: string;
  delegate: SessionPostCompactionDelegate;
  sequence: number;
  compactionCount?: number;
  deliveryContext?: SessionDeliveryContext;
  idempotencyKey?: string;
  childRunId?: string;
}): QueuedSessionDeliveryPayload {
  return {
    kind: "postCompactionDelegate",
    sessionKey: params.sessionKey,
    ...(params.sourceSessionId ? { sourceSessionId: params.sourceSessionId } : {}),
    ...(params.sourceLifecycleRevision
      ? { sourceLifecycleRevision: params.sourceLifecycleRevision }
      : {}),
    task: params.delegate.task,
    createdAt: params.delegate.createdAt,
    firstArmedAt: params.delegate.firstArmedAt ?? params.delegate.createdAt,
    ...(params.delegate.silent != null ? { silent: params.delegate.silent } : {}),
    ...(params.delegate.silentWake != null ? { silentWake: params.delegate.silentWake } : {}),
    ...(params.delegate.targetSessionKey
      ? { targetSessionKey: params.delegate.targetSessionKey }
      : {}),
    ...(params.delegate.targetSessionKeys && params.delegate.targetSessionKeys.length > 0
      ? { targetSessionKeys: params.delegate.targetSessionKeys }
      : {}),
    ...(params.delegate.fanoutMode ? { fanoutMode: params.delegate.fanoutMode } : {}),
    ...(params.delegate.recipientAuthorityBinding
      ? { recipientAuthorityBinding: params.delegate.recipientAuthorityBinding }
      : {}),
    ...(params.delegate.model ? { model: params.delegate.model } : {}),
    ...(params.delegate.attachments && params.delegate.attachments.length > 0
      ? { attachments: params.delegate.attachments }
      : {}),
    ...(params.delegate.attachAs ? { attachAs: params.delegate.attachAs } : {}),
    ...(params.delegate.traceparentProvenance === "internal" && params.delegate.traceparent
      ? {
          traceparent: params.delegate.traceparent,
          traceparentProvenance: "internal" as const,
        }
      : {}),
    ...(params.delegate.flowId ? { sourceFlowId: params.delegate.flowId } : {}),
    ...(params.delegate.expectedRevision !== undefined
      ? { sourceExpectedRevision: params.delegate.expectedRevision }
      : {}),
    ...(params.childRunId ? { childRunId: params.childRunId } : {}),
    ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
    idempotencyKey:
      params.idempotencyKey ??
      buildPostCompactionDelegateIdempotencyKey({
        sessionKey: params.sessionKey,
        delegate: params.delegate,
        sequence: params.sequence,
        compactionCount: params.compactionCount,
      }),
  };
}

/** Enqueue a session delivery and return its durable id. */
export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  context: OpenClawStateWorkerContext,
): Promise<string> {
  return (await enqueueSessionDeliveryWithStatus(params, context)).id;
}

/**
 * Enqueue outcome for callers that must distinguish "this row is now mine to
 * drive" from "a completed tombstone already settled this idempotency key".
 *
 * `enqueueSessionDelivery` only returns the deterministic id, so a caller that
 * also owns an in-memory fast path cannot tell whether it created work or hit a
 * tombstone — and would emit a duplicate notice for an outcome already
 * delivered.
 */
type SessionDeliveryEnqueueResult = {
  id: string;
  /** `completed` means a tombstone settled this key; no new work was created. */
  status: "pending" | "completed" | "unknown";
};

/**
 * Canonical insert-if-absent row for an enqueue. Owners that must commit the
 * enqueue together with their own rows bind it here, before their synchronous
 * write transaction, and insert it with `upsertBoundDeliveryQueueEntryInDatabase`.
 */
export function prepareSessionDeliveryEnqueue(
  params: QueuedSessionDeliveryPayload,
  now = Date.now(),
): { id: string; bound: ReturnType<typeof bindDeliveryQueueEntry> } {
  const entry = prepareSessionDeliveryEntry(params, now);
  return { id: entry.id, bound: prepareEntry(entry, "insert") };
}

/** Upstream's prepareSessionDelivery plus continuation traceparent and storage normalization. */
function prepareSessionDeliveryEntry(
  params: QueuedSessionDeliveryPayload,
  now = Date.now(),
): QueuedSessionDelivery {
  const payload = normalizeQueuedSessionDeliveryTraceparent(params);
  return normalizeSessionDeliveryForStorage({
    ...payload,
    ...(payload.completionRetention === "permanent" ? { retainOnFailure: true as const } : {}),
    id: buildEntryId(payload.idempotencyKey),
    enqueuedAt: now,
    retryCount: 0,
  });
}

export async function enqueueSessionDeliveryWithStatus(
  params: QueuedSessionDeliveryPayload,
  context: OpenClawStateWorkerContext,
): Promise<SessionDeliveryEnqueueResult> {
  const entry = prepareSessionDeliveryEntry(params);
  const { status: current } = await publishSessionDelivery(
    entry,
    "sessionDelivery.enqueue",
    context,
  );
  const status = current === "completed" || current === "pending" ? current : "unknown";
  return { id: entry.id, status };
}

/**
 * Enqueue a post-compaction delegate that has no custody record through the
 * shared durable queue. Every entry carries a launch key (RFC
 * docs/design/continue-work-signal-v2.md §5.4.4, Q2): without one the drain
 * can never prove admission and ends the entry in the interrupted notice.
 */
export async function enqueuePostCompactionDelegateDelivery(
  params: {
    sessionKey: string;
    sourceSessionId?: string;
    sourceLifecycleRevision?: string;
    delegate: SessionPostCompactionDelegate;
    sequence: number;
    compactionCount?: number;
    deliveryContext?: SessionDeliveryContext;
    idempotencyKey?: string;
  },
  context: OpenClawStateWorkerContext,
): Promise<string> {
  return await enqueueSessionDelivery(
    buildPostCompactionDelegateDeliveryPayload({
      ...params,
      childRunId: formatContinuationChildRunId(generateSecureUuid(), 1),
    }),
    context,
  );
}

function publishSessionDelivery<
  Key extends "sessionDelivery.enqueue" | "sessionDelivery.enqueueClaimed",
>(
  entry: QueuedSessionDelivery,
  type: Key,
  context: OpenClawStateWorkerContext,
): Promise<SessionDeliveryWorkerOperations[Key]["output"]> {
  const input = prepareEntry(entry, "insert");
  return withSessionDeliveryEnqueueAdmission(entry, context, (assertCurrent) =>
    runOpenClawStateWorkerOperation(context, (scope) => scope.execute<Key>({ type, input }), {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    }),
  );
}

/** Enqueue and lease the first attempt to one caller before recovery can see it as eligible. */
export async function enqueueClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  context: OpenClawStateWorkerContext,
): Promise<SessionDeliveryWorkerOperations["sessionDelivery.enqueueClaimed"]["output"]> {
  return publishSessionDelivery(
    prepareClaimedSessionDelivery(params, initialAttemptLeaseMs),
    "sessionDelivery.enqueueClaimed",
    context,
  );
}

/** Release the initial-attempt lease so runtime recovery can retry immediately. */
export async function releaseSessionDeliveryClaim(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return executeSessionDelivery(context, {
    type: "sessionDelivery.releaseClaim",
    input: { id },
  });
}

/** Defer a currently owned delivery without consuming its retry budget. */
export async function deferSessionDelivery(
  id: string,
  delayMs: number,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return executeSessionDelivery(context, {
    type: "sessionDelivery.defer",
    input: { id, delayMs },
  });
}

/** Preserve one prepared artifact before transcript persistence or retry transitions. */
export async function mergeSessionDeliveryPreparedMediaBlocks(
  id: string,
  mediaUrl: string,
  blocks: Array<Record<string, unknown>>,
  context: OpenClawStateWorkerContext,
): Promise<Array<Record<string, unknown>>> {
  const result = await executeSessionDelivery(context, {
    type: "sessionDelivery.mergePreparedMedia",
    input: { id, mediaUrl, blocksJson: JSON.stringify(blocks) },
  });
  return result.source === "input" ? blocks : result.blocks;
}

/** Mark an agent turn before it can commit transcript or channel side effects. */
export async function markSessionDeliveryAttemptStarted(
  entry: QueuedSessionDelivery,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  try {
    await executeSessionDelivery(context, {
      type: "sessionDelivery.markAttemptStarted",
      input: prepareEntry(
        { ...entry, deliveryStartedAt: entry.deliveryStartedAt ?? Date.now() },
        "update",
      ),
    });
  } catch (error) {
    throw new SessionDeliveryAttemptStartError(
      `Session delivery ${entry.id} could not persist attempt ownership`,
      { cause: error },
    );
  }
}

/** Persist terminal delivery state while retaining settlement cleanup metadata. */
export async function markSessionDeliverySettlement(
  entry: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  const settledEntry = scrubTerminalQueuedAttachments(entry);
  try {
    await executeSessionDelivery(context, {
      type: "sessionDelivery.markSettlement",
      input: prepareEntry(
        {
          ...settledEntry,
          settlementOutcome: outcome,
          ...(outcome === "recovered"
            ? { acknowledgedAt: settledEntry.acknowledgedAt ?? Date.now() }
            : {}),
        },
        "update",
      ),
    });
  } catch (error) {
    throw new SessionDeliveryAcknowledgementFinalizeError(entry.id, { cause: error });
  }
}

/** Replace a settled pending row with its completed idempotency tombstone. */
export async function completeSessionDelivery(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  try {
    await executeSessionDelivery(context, {
      type: "sessionDelivery.complete",
      input: { id },
    });
  } catch (error) {
    throw new SessionDeliveryAcknowledgementFinalizeError(id, { cause: error });
  }
}

/** Acknowledge a delivered row and retain its completed idempotency tombstone. */
export async function ackSessionDelivery(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  const entry = await loadPendingSessionDelivery(id, context);
  const stateDir = context.environment.OPENCLAW_STATE_DIR;
  if (!entry) {
    const receipt = await inspectDeliveryQueueReceipt(
      SESSION_DELIVERY_QUEUE_NAME,
      id,
      false,
      captureDeliveryQueueStateContext(stateDir),
    );
    if (receipt.status === "completed") {
      return;
    }
    throw new SessionDeliveryAcknowledgementFinalizeError(id);
  }
  await markSessionDeliverySettlement(entry, "recovered", context);
  await completeSessionDelivery(id, context);
}

/** Record a failed delivery attempt and increment retry metadata. */
export async function failSessionDelivery(
  id: string,
  error: string,
  context: OpenClawStateWorkerContext,
  options?: { releaseAttemptOwnership?: boolean },
): Promise<void> {
  await executeSessionDelivery(context, {
    type: "sessionDelivery.fail",
    input: { id, error, ...options },
  });
}

/** Load one pending session delivery by durable id. */
export async function loadPendingSessionDelivery(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<QueuedSessionDelivery | null> {
  const result = await executeSessionDelivery(context, {
    type: "sessionDelivery.load",
    input: { id },
  });
  context.admission.assertCurrent();
  if (!result) {
    return null;
  }
  const decoded = decodeStoredSessionDeliveryResult(result);
  if (decoded.status === "invalid") {
    await failInvalidSessionDelivery({ ...decoded, context });
    context.admission.assertCurrent();
    return null;
  }
  return decoded.entry;
}

/** Load all pending session deliveries in retry order. */
export async function loadPendingSessionDeliveries(
  context: OpenClawStateWorkerContext,
): Promise<QueuedSessionDelivery[]> {
  const results = await executeSessionDelivery(context, {
    type: "sessionDelivery.list",
    input: undefined,
  });
  context.admission.assertCurrent();
  const entries: QueuedSessionDelivery[] = [];
  for (const result of results) {
    const decoded = decodeStoredSessionDeliveryResult(result);
    if (decoded.status === "invalid") {
      await failInvalidSessionDelivery({ ...decoded, context });
      continue;
    }
    entries.push(decoded.entry);
  }
  context.admission.assertCurrent();
  return entries;
}

/**
 * Move an exhausted session delivery out of the pending queue. `keepFailedReceipt` leaves a
 * bounded `failed` receipt that fences the id where the row's own retention would remove it.
 */
export async function moveSessionDeliveryToFailed(
  id: string,
  context: OpenClawStateWorkerContext,
  options?: { keepFailedReceipt?: true },
): Promise<void> {
  return executeSessionDelivery(context, {
    type: "sessionDelivery.moveToFailed",
    input: { id, ...options },
  });
}
