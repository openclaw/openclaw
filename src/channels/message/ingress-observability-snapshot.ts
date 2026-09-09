/** Builds bounded channel-ingress observability snapshots from queue rows and live drain state. */

import {
  CHANNEL_INGRESS_BLOCKERS,
  CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION,
  CHANNEL_INGRESS_OPERATION_KINDS,
  CHANNEL_INGRESS_PREPARATION_STAGES,
  type ChannelIngressActiveOperationSnapshot,
  type ChannelIngressActiveOperationsSnapshot,
  type ChannelIngressBlocker,
  type ChannelIngressBlockerSnapshot,
  type ChannelIngressOperationAggregate,
  type ChannelIngressOperationKind,
  type ChannelIngressObservabilityRow,
  type ChannelIngressObservabilitySnapshot,
  type ChannelIngressObservationRecordRef,
  type ChannelIngressPreparationStage,
  type ChannelIngressProgressMetadataV1,
  type ChannelIngressSnapshotEvent,
  type ChannelIngressStageSnapshot,
  type ChannelIngressUnknownProgressSnapshot,
} from "./ingress-observability-contract.js";
import { readChannelIngressProgressMetadata } from "./ingress-observability.js";

const NO_PROGRESS_INELIGIBLE_BLOCKERS = new Set<ChannelIngressBlocker>([
  "previous_turn",
  "channel_migration",
  "approval",
  "model",
]);
const NO_PROGRESS_INELIGIBLE_STAGES = new Set<ChannelIngressPreparationStage>([
  "execution",
  "delivery",
  "settlement",
]);

function matchesObservationRecord(
  ref: ChannelIngressObservationRecordRef,
  row: ChannelIngressObservabilityRow,
): boolean {
  return (
    ref.eventId === row.event_id &&
    (ref.queueName === undefined || ref.queueName === row.queue_name) &&
    (ref.channelId === undefined || ref.channelId === row.channel_id) &&
    (ref.accountId === undefined || ref.accountId === row.account_id)
  );
}

function emptyStage(stage: ChannelIngressPreparationStage): ChannelIngressStageSnapshot {
  return {
    stage,
    total: 0,
    pending: 0,
    claimed: 0,
    unknownProgress: 0,
    eligibleNoProgressCount: 0,
    blockers: emptyBlockers(),
  };
}

function emptyBlockers(): Record<ChannelIngressBlocker, ChannelIngressBlockerSnapshot> {
  return Object.fromEntries(
    CHANNEL_INGRESS_BLOCKERS.map((blocker) => [
      blocker,
      { blocker, total: 0, pending: 0, claimed: 0 },
    ]),
  ) as Record<ChannelIngressBlocker, ChannelIngressBlockerSnapshot>; // SAFETY: CHANNEL_INGRESS_BLOCKERS enumerates every ChannelIngressBlocker key.
}

function emptyOperation(kind: ChannelIngressOperationKind): ChannelIngressOperationAggregate {
  return { kind, total: 0, known: true, truncated: false, overflowCount: 0 };
}

function normalizeActiveOperationsSnapshot(
  activeOperations:
    | readonly ChannelIngressActiveOperationSnapshot[]
    | ChannelIngressActiveOperationsSnapshot
    | undefined,
): ChannelIngressActiveOperationsSnapshot {
  if (activeOperations === undefined) {
    return { operations: [] };
  }
  return "operations" in activeOperations
    ? activeOperations
    : { operations: [...activeOperations] };
}

export function buildChannelIngressObservabilitySnapshot(params: {
  rows: readonly ChannelIngressObservabilityRow[];
  sampledAt: number;
  activeOperations?:
    | readonly ChannelIngressActiveOperationSnapshot[]
    | ChannelIngressActiveOperationsSnapshot;
  failedCount?: number;
  status?: "known" | "unknown";
}): ChannelIngressObservabilitySnapshot {
  const stages = Object.fromEntries(
    CHANNEL_INGRESS_PREPARATION_STAGES.map((stage) => [stage, emptyStage(stage)]),
  ) as Record<ChannelIngressPreparationStage, ChannelIngressStageSnapshot>; // SAFETY: CHANNEL_INGRESS_PREPARATION_STAGES enumerates every preparation stage key.
  const operations = Object.fromEntries(
    CHANNEL_INGRESS_OPERATION_KINDS.map((kind) => [kind, emptyOperation(kind)]),
  ) as Record<ChannelIngressOperationKind, ChannelIngressOperationAggregate>; // SAFETY: CHANNEL_INGRESS_OPERATION_KINDS enumerates every operation kind key.
  const unknown: ChannelIngressUnknownProgressSnapshot = {
    stage: "unknown",
    total: 0,
    pending: 0,
    claimed: 0,
    unknownProgress: 0,
    eligibleNoProgressCount: 0,
    blockers: emptyBlockers(),
  };
  const activeOperationState = normalizeActiveOperationsSnapshot(params.activeOperations);
  const unknownProgressEvents = activeOperationState.unknownProgressEvents ?? [];

  for (const row of params.rows) {
    if (row.status !== "pending" && row.status !== "claimed") {
      continue;
    }
    const progress = (() => {
      if (unknownProgressEvents.some((event) => matchesObservationRecord(event, row))) {
        return undefined;
      }
      const parsed = readChannelIngressProgressMetadata(row.metadata_json);
      return parsed?.lastProgressAt === undefined ? undefined : parsed;
    })();
    const snapshotEvent = toSnapshotEvent(row, progress, params.sampledAt);
    const aggregate = progress ? stages[progress.stage] : unknown;
    const rowStatus = row.status === "claimed" ? "claimed" : "pending";
    aggregate.total += 1;
    aggregate[rowStatus] += 1;
    if (!progress) {
      aggregate.unknownProgress += 1;
    }
    aggregate.oldestReceiptAgeMs = maxOptional(
      aggregate.oldestReceiptAgeMs,
      snapshotEvent.receiptAgeMs,
    );
    const blockerAggregate = aggregate.blockers[snapshotEvent.blocker];
    blockerAggregate.total += 1;
    blockerAggregate[rowStatus] += 1;
    blockerAggregate.oldestReceiptAgeMs = maxOptional(
      blockerAggregate.oldestReceiptAgeMs,
      snapshotEvent.receiptAgeMs,
    );
    if (isNoProgressEligible(progress) && snapshotEvent.noProgressAgeMs !== undefined) {
      aggregate.eligibleNoProgressCount += 1;
      aggregate.maxEligibleNoProgressAgeMs = maxOptional(
        aggregate.maxEligibleNoProgressAgeMs,
        snapshotEvent.noProgressAgeMs,
      );
    }
    if (!aggregate.oldest || snapshotEvent.receivedAt < aggregate.oldest.receivedAt) {
      aggregate.oldest = snapshotEvent;
    }
  }

  for (const activeOperation of activeOperationState.operations) {
    const operation = operations[activeOperation.kind];
    const ageMs = Math.max(0, params.sampledAt - activeOperation.startedAt);
    operation.total += 1;
    operation.oldestAgeMs = maxOptional(operation.oldestAgeMs, ageMs);
    if (!operation.oldest || activeOperation.startedAt < operation.oldest.startedAt) {
      operation.oldest = { ...activeOperation, ageMs };
    }
  }
  for (const kind of CHANNEL_INGRESS_OPERATION_KINDS) {
    const overflowCount = activeOperationState.overflowByKind?.[kind] ?? 0;
    if (overflowCount > 0) {
      operations[kind].total += overflowCount;
      operations[kind].overflowCount = overflowCount;
      operations[kind].truncated = true;
      operations[kind].known = false;
    }
    if (unknownProgressEvents.length > 0) {
      operations[kind].known = false;
    }
  }

  return {
    type: "ingress.snapshot",
    schemaVersion: CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION,
    sampledAt: params.sampledAt,
    status: params.status ?? "known",
    isolationAvailable: false,
    failedCount: params.failedCount ?? 0,
    stages,
    unknown,
    operations,
  };
}

export function createUnknownChannelIngressObservabilitySnapshot(
  sampledAt: number,
): ChannelIngressObservabilitySnapshot {
  return buildChannelIngressObservabilitySnapshot({
    rows: [],
    sampledAt,
    status: "unknown",
  });
}

function toSnapshotEvent(
  row: ChannelIngressObservabilityRow,
  progress: ChannelIngressProgressMetadataV1 | undefined,
  sampledAt: number,
): ChannelIngressSnapshotEvent {
  const receiptAgeMs = Math.max(0, sampledAt - row.received_at);
  const base: ChannelIngressSnapshotEvent = {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    status: row.status === "claimed" ? "claimed" : "pending",
    receivedAt: row.received_at,
    receiptAgeMs,
    stage: progress?.stage ?? "unknown",
    blocker: progress?.blocker ?? "unknown",
    progressKnown: progress !== undefined,
    updatedAt: row.updated_at,
    ...(row.claimed_at === null
      ? {}
      : { claimedAt: row.claimed_at, claimedAgeMs: Math.max(0, sampledAt - row.claimed_at) }),
  };
  if (!progress) {
    return base;
  }
  return {
    ...base,
    stageStartedAt: progress.stageStartedAt,
    stageAgeMs: Math.max(0, sampledAt - progress.stageStartedAt),
    ...(progress.lastProgressAt === undefined
      ? {}
      : {
          lastProgressAt: progress.lastProgressAt,
          noProgressAgeMs: Math.max(0, sampledAt - progress.lastProgressAt),
        }),
    ...(progress.correlation ? { correlation: progress.correlation } : {}),
    ...(progress.lastOperation ? { lastOperation: progress.lastOperation } : {}),
  };
}

function isNoProgressEligible(progress: ChannelIngressProgressMetadataV1 | undefined): boolean {
  if (progress?.lastProgressAt === undefined) {
    return false;
  }
  return (
    !NO_PROGRESS_INELIGIBLE_BLOCKERS.has(progress.blocker) &&
    !NO_PROGRESS_INELIGIBLE_STAGES.has(progress.stage)
  );
}

function maxOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (right === undefined) {
    return left;
  }
  return left === undefined ? right : Math.max(left, right);
}
