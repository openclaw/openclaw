import type { ChannelIngressQueue, ChannelIngressQueueRecord } from "./ingress-queue.js";

type ChannelIngressPendingDisposition = {
  kind: "fail";
  reason: string;
  message: string;
};

type ChannelIngressPendingDispositionContext = {
  laneKey: string;
  now: number;
};

/**
 * Optional channel policy evaluated before a pending row can be claimed.
 * Unreadable rows must remain eligible for the canonical claim-time codec.
 */
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
  formatError: (err: unknown) => string;
  log: (message: string) => void;
};

export async function applyIngressPendingDispositions<TPayload, TMetadata, TCompletedMetadata>(
  params: ApplyPendingDispositionsParams<TPayload, TMetadata, TCompletedMetadata>,
): Promise<{
  pending: Array<ChannelIngressQueueRecord<TPayload, TMetadata>>;
  blockedLaneKeys: Set<string>;
  errors: unknown[];
}> {
  if (!params.resolve) {
    return { pending: params.pending, blockedLaneKeys: new Set(), errors: [] };
  }

  const retained: Array<ChannelIngressQueueRecord<TPayload, TMetadata>> = [];
  const blockedLaneKeys = new Set<string>();
  const errors: unknown[] = [];
  for (const record of params.pending) {
    const laneKey = params.resolveLaneKey(record);
    if (blockedLaneKeys.has(laneKey)) {
      retained.push(record);
      continue;
    }
    let disposition;
    try {
      disposition = await params.resolve(record, { laneKey, now: params.now });
    } catch (err) {
      params.log(
        `ingress drain: pending disposition policy failed for event ${record.id} on ${laneKey}: ${params.formatError(err)}`,
      );
      retained.push(record);
      blockedLaneKeys.add(laneKey);
      errors.push(err);
      continue;
    }
    if (!disposition) {
      retained.push(record);
      continue;
    }

    const reason = disposition.reason.trim() || "pending-disposition";
    const message = disposition.message.trim() || reason;
    let committed;
    try {
      committed = await params.queue.fail(record.id, {
        reason,
        message,
        failedAt: params.now,
      });
    } catch (err) {
      params.log(
        `ingress drain: pending disposition write failed for event ${record.id} on ${laneKey}: ${params.formatError(err)}`,
      );
      retained.push(record);
      blockedLaneKeys.add(laneKey);
      errors.push(err);
      continue;
    }
    if (!committed) {
      // A concurrent claim won the CAS. Keep its lane out of this snapshot so
      // later same-lane work cannot overtake the authoritative claimant.
      params.log(`ingress drain: pending disposition lost race for event ${record.id}`);
      retained.push(record);
      blockedLaneKeys.add(laneKey);
    }
  }
  return { pending: retained, blockedLaneKeys, errors };
}
