import type {
  ChannelIngressRow,
  ChannelIngressClaimRequest,
  ChannelIngressClaimSnapshot,
  ChannelIngressClaimSelection,
  ChannelIngressQueueRecord,
  ChannelIngressQueueClaim,
  ChannelIngressQueueCorruptClaim,
  ChannelIngressQueueCompletedRecord,
  ChannelIngressQueueDeadLetterRecord,
} from "./ingress-queue.types.js";

// Failed rows need to distinguish a retained JSON null payload from the "null"
// scrub marker written by older versions. Invalid JSON cannot collide with enqueue output.
export const FAILED_NULL_PAYLOAD_SENTINEL = "OPENCLAW_CHANNEL_INGRESS_FAILED_NULL_V1";

type ParseJsonResult = { ok: true; value: unknown } | { ok: false };

function parseJson(value: string): ParseJsonResult {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

export function parseFailedPayload(value: string): ParseJsonResult {
  return value === FAILED_NULL_PAYLOAD_SENTINEL ? { ok: true, value: null } : parseJson(value);
}

export function baseRecord<TPayload, TMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueRecord<TPayload, TMetadata> | null {
  const payloadResult = parseJson(row.payload_json);
  if (!payloadResult.ok) {
    return null;
  }
  const metaResult = row.metadata_json === null ? null : parseJson(row.metadata_json);
  return {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    // SAFETY: The channel codec owns payload validation; the queue preserves its opaque JSON.
    payload: payloadResult.value as TPayload,
    ...(metaResult === null || !metaResult.ok
      ? {}
      : {
          // SAFETY: Metadata round-trips the channel-owned value supplied at enqueue.
          metadata: metaResult.value as TMetadata,
        }),
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    ...(row.lane_key === null ? {} : { laneKey: row.lane_key }),
    attempts: row.attempts,
    ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

type ChannelIngressClaimColumns = ChannelIngressQueueClaim<unknown>["claim"];

// A claimant writes token/owner/claimed_at in one UPDATE, and complete/release/
// refresh all match on claim_token. A claimed row missing any of the three has
// no reachable owner and could never be released; reject it instead of minting
// sentinel claim identity that release/liveness checks silently fail against.
export function decodeClaimColumns(row: ChannelIngressRow): ChannelIngressClaimColumns | null {
  if (!row.claim_token || !row.claim_owner || row.claimed_at === null) {
    return null;
  }
  return { token: row.claim_token, ownerId: row.claim_owner, claimedAt: row.claimed_at };
}

export function claimedRecord<TPayload, TMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueClaim<TPayload, TMetadata> | null {
  const claim = decodeClaimColumns(row);
  const base = claim === null ? null : baseRecord<TPayload, TMetadata>(row);
  if (claim === null || base === null) {
    return null;
  }
  return { ...base, claim };
}

export function corruptClaimRecord(
  row: ChannelIngressRow,
  claim: ChannelIngressClaimColumns,
): ChannelIngressQueueCorruptClaim {
  return {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    ...(row.lane_key === null ? {} : { laneKey: row.lane_key }),
    reason: "corrupt_payload",
    claim,
  };
}

export function completedRecord<TCompletedMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueCompletedRecord<TCompletedMetadata> {
  const metaResult =
    row.completed_metadata_json === null ? null : parseJson(row.completed_metadata_json);
  return {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    completedAt: row.completed_at ?? row.updated_at,
    ...(metaResult === null || !metaResult.ok
      ? {}
      : {
          // SAFETY: Completion metadata round-trips the value supplied by this queue's consumer.
          metadata: metaResult.value as TCompletedMetadata,
        }),
  };
}

export function failedRecord<TPayload, TMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueDeadLetterRecord<TPayload, TMetadata> {
  const payloadResult = parseFailedPayload(row.payload_json);
  const metadataResult = row.metadata_json === null ? null : parseJson(row.metadata_json);
  return {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    ...(payloadResult.ok && row.payload_json !== "null"
      ? {
          // SAFETY: Retained payloads keep the same channel-owned codec contract after failure.
          payload: payloadResult.value as TPayload,
        }
      : {}),
    ...(metadataResult?.ok
      ? {
          // SAFETY: Failure retains the original channel-owned enqueue metadata unchanged.
          metadata: metadataResult.value as TMetadata,
        }
      : {}),
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    ...(row.lane_key === null ? {} : { laneKey: row.lane_key }),
    attempts: row.attempts,
    ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
    failedAt: row.failed_at ?? row.updated_at,
    reason: row.failed_reason ?? "failed",
    ...(row.last_error === null ? {} : { message: row.last_error }),
  };
}

export const CHANNEL_INGRESS_CORRUPT_REPAIR_LIMIT = 100;

/** Bound the number of bounded pages one claim scans past fully blocked lanes. */
export const CHANNEL_INGRESS_CLAIM_SCAN_PAGE_BUDGET = 10;

/** Resolve host policy only for the rows the original bounded scan would visit. */
export function selectChannelIngressClaim(
  snapshot: ChannelIngressClaimSnapshot,
  request: ChannelIngressClaimRequest,
  resolveLane: (row: ChannelIngressRow) => string | undefined,
): ChannelIngressClaimSelection {
  const blocked = new Set(request.blockedLaneKeys);
  for (const row of snapshot.claimed) {
    const lane = resolveLane(row);
    if (lane) {
      blocked.add(lane);
    }
  }
  const corruptIds: string[] = [];
  const pending = snapshot.pending;
  const scanLimit = Math.max(1, Math.floor(request.scanLimit ?? 100));
  let scanOffset = 0;
  let corruptCapHit = false;
  while (scanOffset < pending.length) {
    const window = pending.slice(scanOffset, scanOffset + scanLimit);
    if (window.length === 0) {
      break;
    }
    for (const row of window) {
      if (!baseRecord(row)) {
        if (corruptIds.length < CHANNEL_INGRESS_CORRUPT_REPAIR_LIMIT) {
          corruptIds.push(row.event_id);
        }
        continue;
      }
      const laneKey = resolveLane(row);
      if (!laneKey || !blocked.has(laneKey)) {
        return { corruptIds, selected: { id: row.event_id, laneKey } };
      }
    }
    // Scan the next bounded window of this snapshot. Corrupt rows are collected
    // but the scan window is bounded by the snapshot's repair allowance.
    scanOffset += window.length;
    if (corruptIds.length >= CHANNEL_INGRESS_CORRUPT_REPAIR_LIMIT) {
      corruptCapHit = true;
      break;
    }
  }
  if (corruptCapHit) {
    // Corrupt repair budget is consumed; rows beyond the scan point must stay
    // reachable on a later scan, so do not page past them here.
    return { corruptIds };
  }
  // The whole snapshot held no eligible row. Signal another bounded page when
  // the snapshot consumed its full allowance, so a free lane beyond a fully
  // blocked prefix stays reachable instead of wedging the claim.
  return {
    corruptIds,
    ...(pending.length >= scanLimit + CHANNEL_INGRESS_CORRUPT_REPAIR_LIMIT ? { more: true } : {}),
  };
}
