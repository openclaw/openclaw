/**
 * Core-owned pre-claim disposition pass. A channel may settle a stored pending
 * row that can never become work, or hold one it cannot classify yet, before
 * the drain builds its candidate window. The hook never sees a claim.
 */
// Leaf types only: ingress-queue.ts sits inside the state-worker import graph.
import type { ChannelIngressQueue, ChannelIngressQueueRecord } from "./ingress-queue.types.js";

type ChannelIngressPendingDisposition =
  /**
   * Terminally fail the stored row; it can never become work. `isStillValid`
   * (default valid) is re-checked at the fail's commit; false leaves the row
   * pending for the next pass.
   */
  | { kind: "fail"; reason: string; message: string; isStillValid?: () => boolean }
  /** Hold the row and its lane for this pass; the channel cannot classify it yet. */
  | { kind: "defer" };

type ChannelIngressPendingDispositionContext = {
  laneKey: string;
  now: number;
};

/** Unreadable rows must remain eligible for the canonical claim-time codec. */
export type ResolveChannelIngressPendingDisposition<TPayload, TMetadata> = (
  record: ChannelIngressQueueRecord<TPayload, TMetadata>,
  context: ChannelIngressPendingDispositionContext,
) =>
  | ChannelIngressPendingDisposition
  | null
  | undefined
  | Promise<ChannelIngressPendingDisposition | null | undefined>;

type ApplyPendingDispositionsParams<TPayload, TMetadata, TCompletedMetadata> = {
  pending: Array<ChannelIngressQueueRecord<TPayload, TMetadata>>;
  now: number;
  queue: Pick<ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>, "fail">;
  resolve?: ResolveChannelIngressPendingDisposition<TPayload, TMetadata>;
  resolveLaneKey: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string;
  log: (message: string) => void;
};

export async function applyIngressPendingDispositions<TPayload, TMetadata, TCompletedMetadata>(
  params: ApplyPendingDispositionsParams<TPayload, TMetadata, TCompletedMetadata>,
): Promise<{
  pending: Array<ChannelIngressQueueRecord<TPayload, TMetadata>>;
  blockedLaneKeys: Set<string>;
}> {
  const resolve = params.resolve;
  if (!resolve) {
    return { pending: params.pending, blockedLaneKeys: new Set() };
  }

  const retained: Array<ChannelIngressQueueRecord<TPayload, TMetadata>> = [];
  const blockedLaneKeys = new Set<string>();
  for (const record of params.pending) {
    const laneKey = params.resolveLaneKey(record);
    if (blockedLaneKeys.has(laneKey)) {
      // The lane head keeps ordering: nothing behind it is settled or started.
      retained.push(record);
      continue;
    }
    const disposition = await resolve(record, { laneKey, now: params.now });
    if (!disposition) {
      retained.push(record);
      continue;
    }
    if (disposition.kind === "defer") {
      retained.push(record);
      blockedLaneKeys.add(laneKey);
      continue;
    }

    const reason = disposition.reason.trim() || "pending-disposition";
    const committed = await params.queue.fail(record.id, {
      reason,
      message: disposition.message.trim() || reason,
      failedAt: params.now,
      // Only the generation the policy judged; a row claimed, failed and
      // resubmitted while the policy ran is fresh work and stays pending.
      generation: { updatedAt: record.updatedAt },
      // The verdict's own guard runs at the commit grant, not before this
      // await: an input change after the policy returned rolls the fail back.
      ...(disposition.isStillValid ? { isCurrent: disposition.isStillValid } : {}),
    });
    if (!committed) {
      // A concurrent transition won, or the verdict went stale before its
      // commit; hold the lane so later same-lane work cannot overtake it.
      params.log(
        disposition.isStillValid?.() === false
          ? `ingress drain: pending disposition invalidated before commit for event ${record.id}`
          : `ingress drain: pending disposition lost race for event ${record.id}`,
      );
      retained.push(record);
      blockedLaneKeys.add(laneKey);
    }
  }
  return { pending: retained, blockedLaneKeys };
}
