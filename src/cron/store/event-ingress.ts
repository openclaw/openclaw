import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  completeChannelIngressInDatabase,
  readChannelIngressClaimSnapshotInDatabase,
} from "../../channels/message/ingress-queue.kernel.js";
import type { CronEventAdmission } from "../event-source.js";
import { cronSourceIdentity } from "../source-schedule.js";
import type { CronJob } from "../types.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";

/** The existing ingress owner reads the exact row inside cron's admitted worker transaction. */
export function readCronEventClaimInDatabase(
  db: DatabaseSync,
  job: CronJob,
  event: CronEventAdmission,
) {
  if (
    job.schedule.kind !== "event" ||
    !job.enabled ||
    job.state.autoDisabled ||
    job.id !== event.input.jobId ||
    cronSourceIdentity(job) !== event.input.sourceIdentity
  ) {
    return undefined;
  }
  const row = readChannelIngressClaimSnapshotInDatabase(db, {
    queueName: event.claim.queueName,
    candidateIds: [event.claim.id],
    blockedLaneKeys: [],
    deriveLaneKey: false,
    scanLimit: 1,
  }).claimed.find((candidate) => candidate.event_id === event.claim.id);
  if (!row || row.claim_token !== event.claim.token || row.channel_id !== job.schedule.source) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return undefined;
  }
  return isDeepStrictEqual(payload, event.input) ? row : undefined;
}

/**
 * The activation receipt and completed ingress tombstone share one native commit.
 * A crash before it leaves the immutable claim retryable; a crash after it uses
 * ordinary interrupted-run recovery and must never replay external side effects.
 */
export function transferCronEventInDatabase(
  db: DatabaseSync,
  job: CronJob,
  event: CronEventAdmission,
  receipt: CronRunReceiptHandle,
  now: number,
): void {
  const row = readCronEventClaimInDatabase(db, job, event);
  if (
    !row ||
    !completeChannelIngressInDatabase(db, {
      channelId: row.channel_id,
      accountId: row.account_id,
      queueName: event.claim.queueName,
      id: event.claim.id,
      token: event.claim.token,
      now,
      metadataJson: JSON.stringify({
        jobId: job.id,
        eventId: event.input.eventId,
        receiptId: receipt.receiptId,
      }),
    })
  ) {
    throw new Error("cron event ingress claim is no longer current");
  }
}
