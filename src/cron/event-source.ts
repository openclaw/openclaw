import { createHash } from "node:crypto";
import { wrapExternalContent } from "../security/external-content.js";
import type { CronJob, CronPayload } from "./types.js";

/** Generic envelope budget, independent of a source adapter's smaller wire limit. */
export const MAX_CRON_EVENT_PAYLOAD_BYTES = 1_048_576;
export const MAX_CRON_EVENT_METADATA_BYTES = 65_536;

/** Immutable payload stored in the existing durable ingress queue. */
export type CronEventInput = {
  jobId: string;
  sourceIdentity: string;
  eventId: string;
  receivedAtMs: number;
  payload: unknown;
};

/** The token must refer to a claim in the same admitted shared-state database. */
type CronEventClaim = { queueName: string; id: string; token: string };
export type CronEventRunOptions = Omit<CronEventInput, "jobId"> & {
  claim: CronEventClaim;
  /** Captured plugin service/source authority, checked at transaction and commit. */
  commitGuard: () => void;
};
export type CronEventRunResult =
  | { kind: "transferred"; receiptId: string; runId: string }
  | { kind: "pending"; reason: "busy" | "paused" | "stopped" }
  | { kind: "invalidated" };
export type CronEventSourceSnapshot = {
  jobId: string;
  sourceIdentity: string;
  enabled: boolean;
  options: Record<string, unknown>;
};
export type CronEventAdmission = { input: CronEventInput; claim: CronEventClaim };

export class CronEventClaimInvalidatedError extends Error {
  constructor() {
    super("automation event claim is no longer current");
  }
}

export function cronEventRunId(event: CronEventAdmission): string {
  return (
    "event:" +
    createHash("sha256")
      .update(
        JSON.stringify([
          event.claim.queueName,
          event.claim.id,
          event.input.jobId,
          event.input.sourceIdentity,
          event.input.eventId,
        ]),
      )
      .digest("hex")
  );
}

/** Event data cannot replace trusted instructions or change the creator's tool policy. */
export function cronEventPayload(job: CronJob, input: CronEventInput): CronPayload {
  if (job.payload.kind !== "agentTurn") {
    throw new Error("event schedules require an agentTurn payload");
  }
  return {
    ...job.payload,
    message:
      job.payload.message +
      "\n\n" +
      wrapExternalContent(
        JSON.stringify({
          eventId: input.eventId,
          receivedAtMs: input.receivedAtMs,
          payload: input.payload,
        }),
        { source: "webhook", includeWarning: true },
      ),
  };
}
