import path from "node:path";
import { buildInboundMediaNote } from "../auto-reply/media-note.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { normalizeChatType } from "../channels/chat-type.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { generateSecureUuid } from "./secure-random.js";
import type { QueuedSessionDeliveryPayload } from "./session-delivery-queue.js";
import type { UpdateConfirmationTier } from "./update-handover.js";

export type PendingUpdateConfirmation = {
  handoffId: string;
  sessionKey: string;
  channel: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  tier: UpdateConfirmationTier;
  confirmationChallenge?: string;
  stateSnapshotRoot?: string;
};

type UpdateProbationResolution = "confirmed" | "cancelled";

let pendingConfirmation: PendingUpdateConfirmation | null = null;
let resolutionPromise: Promise<UpdateProbationResolution> | null = null;
let resolveProbation: ((resolution: UpdateProbationResolution) => void) | null = null;
let inboundReleasePromise: Promise<void> | null = null;
let releaseInbound: (() => void) | null = null;
let probationCancelled = false;
let confirmationSealing = false;
let stopOwnerLeaseWatchdog: (() => void) | null = null;
let confirmedContinuation: {
  handoffId: string;
  run: () => Promise<void>;
  onError?: (error: unknown) => void;
} | null = null;
const CONFIRMATION_PERSIST_RETRY_MS = process.env.VITEST ? 1 : 250;
const PROBATION_DELIVERY_LEASE_MS = 15 * 60_000;
const deferredCandidateDeliveryIds = new Set<string>();
const inFlightReplayPersistences = new Set<Promise<string>>();

function buildRollbackReplayMessage(ctx: FinalizedMsgContext): string {
  const body =
    ctx.BodyForAgent ?? ctx.Body ?? ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? "";
  const mediaNote = buildInboundMediaNote(ctx);
  return [body.trim(), mediaNote?.trim()].filter(Boolean).join("\n");
}

async function persistRollbackReplay(params: {
  pending: PendingUpdateConfirmation;
  sessionKey: string;
  channel: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  ctxPayload: FinalizedMsgContext;
  messageId?: string;
}): Promise<string> {
  const snapshotRoot = params.pending.stateSnapshotRoot;
  const to = params.to;
  if (!snapshotRoot) {
    throw new Error("update rollback snapshot is unavailable");
  }
  const messageId =
    params.messageId ??
    params.ctxPayload.MessageSidFull ??
    params.ctxPayload.MessageSid ??
    generateSecureUuid();
  const { beginUpdateTransactionReplayAdmission, completeUpdateTransactionReplayAdmission } =
    await import("./update-transaction-marker.js");
  const began = await beginUpdateTransactionReplayAdmission({
    handoffId: params.pending.handoffId,
  });
  if (!began) {
    throw new Error("update replay admission fence is unavailable");
  }
  const payload = {
    // Existing shipped queue shape. Both candidate and retained package can
    // replay it; candidate-only payload variants would strand rollback work.
    kind: "agentTurn" as const,
    sessionKey: params.sessionKey,
    message: buildRollbackReplayMessage(params.ctxPayload),
    messageId,
    ...(to
      ? {
          route: {
            channel: params.channel,
            to,
            ...(params.accountId ? { accountId: params.accountId } : {}),
            ...(params.ctxPayload.ReplyToId ? { replyToId: params.ctxPayload.ReplyToId } : {}),
            ...(params.threadId ? { threadId: params.threadId } : {}),
            chatType: normalizeChatType(params.ctxPayload.ChatType) ?? "direct",
          },
        }
      : {}),
    ...(params.ctxPayload.InputProvenance
      ? { inputProvenance: params.ctxPayload.InputProvenance }
      : {}),
    idempotencyKey: `update-probation-inbound:${params.pending.handoffId}:${params.sessionKey}:${messageId}`,
  };
  const { enqueueClaimedSessionDelivery, enqueueSessionDeliveryInExistingState } =
    await import("./session-delivery-queue.js");
  await enqueueSessionDeliveryInExistingState(payload, path.join(snapshotRoot, "state"));
  const candidate = await enqueueClaimedSessionDelivery(payload, PROBATION_DELIVERY_LEASE_MS);
  const { scheduleSessionDelivery } = await import("./session-delivery-queue-runtime.js");
  await scheduleSessionDelivery(candidate.id);
  deferredCandidateDeliveryIds.add(candidate.id);
  const completed = await completeUpdateTransactionReplayAdmission({
    handoffId: params.pending.handoffId,
  });
  if (!completed) {
    throw new Error("update replay admission fence could not commit");
  }
  return candidate.id;
}

/** Close replay admission, then wait until every consumed callback is durable in both stores. */
export async function sealUpdateConfirmationReplayAdmissions(handoffId: string): Promise<boolean> {
  if (pendingConfirmation?.handoffId !== handoffId || probationCancelled) {
    return false;
  }
  confirmationSealing = true;
  try {
    await Promise.all([...inFlightReplayPersistences]);
  } catch {
    return false;
  }
  return pendingConfirmation?.handoffId === handoffId && !probationCancelled;
}

async function failProbationAndBlock(
  pending: PendingUpdateConfirmation,
  reason: string,
): Promise<never> {
  while (pendingConfirmation?.handoffId === pending.handoffId && !probationCancelled) {
    try {
      const { markUpdateTransactionConfirmationFailed } =
        await import("./update-transaction-marker.js");
      const failed = await markUpdateTransactionConfirmationFailed({
        handoffId: pending.handoffId,
        reason,
      });
      if (failed?.payload.stats?.confirmationStatus === "failed") {
        await resolveUpdateConfirmationProbation(pending.handoffId, "cancelled");
        break;
      }
    } catch {}
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CONFIRMATION_PERSIST_RETRY_MS);
      timer.unref?.();
    });
  }
  // The provider callback stays owned by the dying candidate. The detached
  // updater sees the failed marker and restores the retained snapshot.
  return await new Promise<never>(() => {});
}

async function fenceProbationFailureAndBlock(
  pending: PendingUpdateConfirmation,
  reason: string,
): Promise<never> {
  while (pendingConfirmation?.handoffId === pending.handoffId && !probationCancelled) {
    try {
      const { beginUpdateTransactionReplayAdmission } =
        await import("./update-transaction-marker.js");
      if (await beginUpdateTransactionReplayAdmission({ handoffId: pending.handoffId })) {
        break;
      }
    } catch {}
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CONFIRMATION_PERSIST_RETRY_MS);
      timer.unref?.();
    });
  }
  return await failProbationAndBlock(pending, reason);
}

async function failInboundProbationWithFence(
  pending: PendingUpdateConfirmation,
  reason: string,
): Promise<never> {
  const failure = fenceProbationFailureAndBlock(pending, reason);
  inFlightReplayPersistences.add(failure);
  try {
    return await failure;
  } finally {
    inFlightReplayPersistences.delete(failure);
  }
}

async function releaseDeferredCandidateDeliveries(handoffId: string): Promise<void> {
  const { loadPendingSessionDeliveries, releaseSessionDeliveryClaim } =
    await import("./session-delivery-queue.js");
  const replayPrefixes = [
    `update-probation-inbound:${handoffId}:`,
    `update-transaction-continuation:${handoffId}:`,
  ];
  const pending = await loadPendingSessionDeliveries();
  const ids = new Set(deferredCandidateDeliveryIds);
  for (const entry of pending) {
    if (replayPrefixes.some((prefix) => entry.idempotencyKey?.startsWith(prefix))) {
      ids.add(entry.id);
    }
  }
  for (const id of ids) {
    await releaseSessionDeliveryClaim(id);
  }
  const { schedulePendingSessionDeliveries } = await import("./session-delivery-queue-runtime.js");
  await schedulePendingSessionDeliveries();
  for (const id of ids) {
    deferredCandidateDeliveryIds.delete(id);
  }
}

/** Keep post-update work leased until the update confirmation boundary releases it. */
export async function enqueueUpdateConfirmationContinuation(
  payload: QueuedSessionDeliveryPayload,
): Promise<string> {
  const { enqueueClaimedSessionDelivery } = await import("./session-delivery-queue.js");
  const queued = await enqueueClaimedSessionDelivery(payload, PROBATION_DELIVERY_LEASE_MS);
  deferredCandidateDeliveryIds.add(queued.id);
  return queued.id;
}

type HumanConfirmationMarkerParams = {
  handoffId: string;
  sessionKey: string;
  channel: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  confirmationChallenge: string;
};

async function persistHumanConfirmationWithRetry(
  pending: PendingUpdateConfirmation,
  markerParams: HumanConfirmationMarkerParams,
): Promise<"confirmed" | "retrying"> {
  const scheduleRetry = () => {
    const timer = setTimeout(() => {
      if (pendingConfirmation?.handoffId === pending.handoffId && !probationCancelled) {
        void persistHumanConfirmationWithRetry(pending, markerParams);
      }
    }, CONFIRMATION_PERSIST_RETRY_MS);
    timer.unref?.();
  };
  try {
    if (!(await sealUpdateConfirmationReplayAdmissions(pending.handoffId))) {
      scheduleRetry();
      return "retrying";
    }
    const { markUpdateTransactionHumanReply } = await import("./update-transaction-marker.js");
    const updated = await markUpdateTransactionHumanReply(markerParams);
    if (updated?.payload.stats?.confirmationStatus !== "human-confirmed") {
      // The user may answer immediately after transport acknowledgement but
      // before its marker write commits. Keep the challenge reply durable in
      // this callback until that ordering race settles or rollback terminates us.
      scheduleRetry();
      return "retrying";
    }
    await resolveUpdateConfirmationProbation(pending.handoffId, "confirmed");
    return "confirmed";
  } catch {
    scheduleRetry();
    return "retrying";
  }
}

export function registerPendingUpdateConfirmation(
  pending: PendingUpdateConfirmation,
  options: { replayAdmissionsSealed?: boolean } = {},
): void {
  pendingConfirmation = { ...pending };
  resolutionPromise = new Promise((resolve) => {
    resolveProbation = resolve;
  });
  inboundReleasePromise = new Promise((resolve) => {
    releaseInbound = resolve;
  });
  probationCancelled = false;
  confirmationSealing = options.replayAdmissionsSealed === true;
}

export function registerPendingHumanUpdateConfirmation(
  pending: Omit<PendingUpdateConfirmation, "tier">,
): void {
  registerPendingUpdateConfirmation({ ...pending, tier: "human" });
}

export function getPendingUpdateConfirmation(): PendingUpdateConfirmation | null {
  return pendingConfirmation ? { ...pendingConfirmation } : null;
}

export function registerUpdateConfirmationContinuation(params: {
  handoffId: string;
  run: () => Promise<void>;
  onError?: (error: unknown) => void;
}): void {
  if (pendingConfirmation?.handoffId === params.handoffId) {
    confirmedContinuation = params;
  }
}

export function isUpdateConfirmationProbationActive(): boolean {
  return pendingConfirmation !== null;
}

export async function resolveUpdateConfirmationProbation(
  handoffId: string,
  resolution: UpdateProbationResolution,
): Promise<void> {
  if (pendingConfirmation?.handoffId !== handoffId) {
    return;
  }
  if (probationCancelled && resolution === "confirmed") {
    return;
  }
  if (resolution === "cancelled") {
    // Provider callbacks have already consumed their events. Keep them
    // unresolved until service termination so rollback never reports a drop.
    probationCancelled = true;
    resolveProbation?.(resolution);
    resolveProbation = null;
    return;
  }
  if (!(await sealUpdateConfirmationReplayAdmissions(handoffId))) {
    throw new Error("update probation replay admissions could not be sealed");
  }
  await releaseDeferredCandidateDeliveries(handoffId);
  const { markUpdateTransactionProbationReleased } = await import("./update-transaction-marker.js");
  const released = await markUpdateTransactionProbationReleased({ handoffId });
  if (typeof released?.payload.stats?.updateProbationReleasedAtMs !== "number") {
    throw new Error("update probation release could not be committed");
  }
  const { scheduleConfirmedUpdateCleanup } = await import("./update-interrupted-recovery.js");
  const leaseExpiresAt = released.payload.stats.updateOwnerLeaseExpiresAtMs;
  scheduleConfirmedUpdateCleanup({
    handoffId,
    runAtMs:
      typeof leaseExpiresAt === "number"
        ? Math.max(Date.now() + 1, leaseExpiresAt + 1)
        : Date.now() + 1,
    env: process.env,
  });
  const continuation =
    confirmedContinuation?.handoffId === handoffId ? confirmedContinuation : null;
  confirmedContinuation = null;
  stopOwnerLeaseWatchdog?.();
  stopOwnerLeaseWatchdog = null;
  pendingConfirmation = null;
  releaseInbound?.();
  releaseInbound = null;
  resolveProbation?.(resolution);
  resolveProbation = null;
  if (continuation) {
    void continuation.run().catch(continuation.onError);
  }
}

export function startUpdateConfirmationOwnerLeaseWatchdog(params: {
  handoffId: string;
  pollMs?: number;
  claimExpired?: (handoffId: string, rollbackOwner: string) => Promise<boolean>;
  onExpired: () => void;
}): () => void {
  stopOwnerLeaseWatchdog?.();
  const rollbackOwner = generateSecureUuid();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
  stopOwnerLeaseWatchdog = stop;
  const schedule = () => {
    timer = setTimeout(() => void tick(), params.pollMs ?? 1_000);
    timer.unref?.();
  };
  const tick = async () => {
    if (stopped) {
      return;
    }
    try {
      const claimed = params.claimExpired
        ? await params.claimExpired(params.handoffId, rollbackOwner)
        : await import("./update-transaction-marker.js").then(
            async ({ claimExpiredUpdateTransactionOwner }) =>
              (await claimExpiredUpdateTransactionOwner({
                handoffId: params.handoffId,
                rollbackOwner,
              })) !== null,
          );
      if (claimed) {
        void resolveUpdateConfirmationProbation(params.handoffId, "cancelled");
        params.onExpired();
        return;
      }
    } catch {
      // A transient SQLite read cannot silently disable abandoned-owner recovery.
    }
    schedule();
  };
  schedule();
  return stop;
}

export async function waitForUpdateConfirmationProbation(): Promise<UpdateProbationResolution> {
  return (await resolutionPromise) ?? "cancelled";
}

export function clearPendingHumanUpdateConfirmation(handoffId: string): void {
  void resolveUpdateConfirmationProbation(handoffId, "cancelled");
}

/**
 * Gate all normal channel turns while a rollback-capable gateway is in
 * probation. The matching human reply is persisted before any session or
 * agent work; all other turns are durably deferred without blocking intake.
 */
export async function handleUpdateProbationInbound(params: {
  sessionKey: string;
  channel: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  internal: boolean;
  confirmationEligible?: boolean;
  confirmationText?: string;
  rollbackReplay?: {
    admission?: "dispatch" | "observeOnly";
    ctxPayload: FinalizedMsgContext;
    messageId?: string;
  };
}): Promise<"continue" | "handled" | "deferred" | "cancelled"> {
  const pending = pendingConfirmation;
  if (!pending) {
    return "continue";
  }
  if (
    !params.internal &&
    params.confirmationEligible !== false &&
    pending.tier === "human" &&
    pending.sessionKey === params.sessionKey &&
    pending.channel === params.channel &&
    pending.to === params.to &&
    normalizeAccountId(pending.accountId) === normalizeAccountId(params.accountId) &&
    pending.threadId === params.threadId &&
    typeof pending.confirmationChallenge === "string" &&
    params.confirmationText?.trim() === `confirm ${pending.confirmationChallenge}`
  ) {
    const persisted = await persistHumanConfirmationWithRetry(pending, {
      handoffId: pending.handoffId,
      sessionKey: params.sessionKey,
      channel: params.channel,
      ...(params.to ? { to: params.to } : {}),
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
      confirmationChallenge: pending.confirmationChallenge,
    });
    if (persisted === "retrying") {
      await inboundReleasePromise;
    }
    return "handled";
  }
  if (params.rollbackReplay) {
    if (params.rollbackReplay.admission === "observeOnly") {
      if (confirmationSealing) {
        await inboundReleasePromise;
        return "continue";
      }
      // The retained package predates this transaction and cannot decode a new
      // observe-only queue shape. Keep the provider callback unacknowledged and
      // roll back instead of replaying it as a reply-capable agent turn.
      return await failInboundProbationWithFence(
        pending,
        "update callback replay cannot preserve observe-only admission",
      );
    }
    if (confirmationSealing) {
      await inboundReleasePromise;
      return "continue";
    }
    const persistence = persistRollbackReplay({
      pending,
      sessionKey: params.sessionKey,
      channel: params.channel,
      ...(params.to ? { to: params.to } : {}),
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...params.rollbackReplay,
    });
    inFlightReplayPersistences.add(persistence);
    try {
      await persistence;
      return "deferred";
    } catch (error) {
      return await failProbationAndBlock(
        pending,
        `update callback replay persistence failed: ${String(error)}`,
      );
    } finally {
      inFlightReplayPersistences.delete(persistence);
    }
  }
  if (confirmationSealing) {
    await inboundReleasePromise;
    return "continue";
  }
  return await failInboundProbationWithFence(
    pending,
    "update callback lacks durable replay context",
  );
}

export async function maybeConfirmUpdateFromInbound(params: {
  sessionKey: string;
  channel: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  internal: boolean;
  confirmationText?: string;
}): Promise<boolean> {
  return (await handleUpdateProbationInbound(params)) === "handled";
}

export function resetPendingHumanUpdateConfirmationForTest(): void {
  stopOwnerLeaseWatchdog?.();
  stopOwnerLeaseWatchdog = null;
  pendingConfirmation = null;
  probationCancelled = false;
  confirmationSealing = false;
  confirmedContinuation = null;
  resolutionPromise = null;
  resolveProbation = null;
  inboundReleasePromise = null;
  releaseInbound = null;
  deferredCandidateDeliveryIds.clear();
  inFlightReplayPersistences.clear();
}
