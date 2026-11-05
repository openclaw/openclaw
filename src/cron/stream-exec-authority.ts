import { isDeepStrictEqual } from "node:util";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SandboxContext } from "../agents/sandbox/types.js";
import type { ExecApprovalPreparedConsumption } from "../gateway/operator-approval-store.types.js";
import type { ExecApprovalsFile, ExecAsk, ExecSecurity } from "../infra/exec-approvals-core.js";
import { isRecord } from "../utils.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { cronStreamScheduleKey, type CronStreamSchedule } from "./stream-schedule.js";
import type { CronStoredJob } from "./types.js";

export const CRON_STREAM_EXEC_AUTHORITY_ERROR =
  "automation stream commands require the creator turn to have Gateway exec authority or admitted Docker sandbox exec authority, and either unattended execution or explicit user approval; denied and node-only execution cannot create a stream.";

/** The configuration owner rejected the capability, rather than malformed input. */
export class CronStreamPolicyDeniedError extends TypeError {}

export type CronStreamExecMutation = {
  method: "cron.add" | "cron.update";
  job: CronStoredJob;
  previousJob?: CronStoredJob;
};

export function cronStreamExecApprovalBinding(mutation: CronStreamExecMutation): string {
  // The source's derived revision includes creation time, which changes on approval retry.
  const { operatorSource, ...job } = mutation.job;
  return JSON.stringify([
    mutation.method,
    resolveCronJobConfigRevision({ ...job, createdAtMs: 0 }),
    operatorSource?.source ?? null,
    mutation.previousJob ? resolveCronJobConfigRevision(mutation.previousJob) : null,
  ]);
}

/** Only a confirmed rolled-back mutation supplies a proposal for the approval owner. */
export class CronStreamExecApprovalRequiredError extends TypeError {
  mutation?: CronStreamExecMutation;

  constructor(
    readonly policyKey: string,
    readonly security: ExecSecurity,
    readonly ask: ExecAsk,
  ) {
    super("This persistent stream requires the user's approval before it can be saved.");
  }
}

export type CronStreamExecApproval = {
  /** Retain creation identity, including derived authority revisions, across the approval wait. */
  createdAtMs: number;
  policyKey: string;
  binding: string;
  consumption: ExecApprovalPreparedConsumption;
};

/** Historical confirmation of the native approval consumed by this stream mutation. */
export type CronStreamExecApprovalReceipt = {
  approvalId: string;
  decision: "allow-once";
  source: "operator";
};

/** Prepared run policy; only the host-floor branch reads approvals at the write boundary. */
export type CronStreamExecPolicy = {
  sandboxContext?: SandboxContext;
  /** Rechecks cancellation and the creator’s captured policy at the mutation boundary. */
  assertCurrentSource?: () => void;
  /** Per-invocation result projection only; never grants execution authority. */
  onApprovalCommitted?: (receipt: CronStreamExecApprovalReceipt) => void;
} & (
  | { kind: "resolved"; assertCurrent: (approvedPolicyKey?: string) => void }
  | {
      kind: "needs-approvals";
      assertCurrent: (file: ExecApprovalsFile, approvedPolicyKey?: string) => void;
    }
);

function isCronStreamSchedule(value: unknown): value is CronStreamSchedule {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    normalizeLowercaseStringOrEmpty(value.kind) !== "stream"
  ) {
    return false;
  }
  return (
    Array.isArray(value.command) &&
    value.command.length > 0 &&
    value.command.every((entry): entry is string => typeof entry === "string")
  );
}

export function cronCreateRequiresStreamExecAuthority(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const schedule = isRecord(value.schedule) ? value.schedule : undefined;
  return (
    typeof schedule?.kind === "string" &&
    normalizeLowercaseStringOrEmpty(schedule.kind) === "stream"
  );
}

export function cronMutationRequiresStreamExecAuthority(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const schedule = isRecord(value.schedule) ? value.schedule : undefined;
  if (!schedule) {
    return false;
  }
  const scheduleKind =
    typeof schedule.kind === "string" ? normalizeLowercaseStringOrEmpty(schedule.kind) : undefined;
  if (scheduleKind !== undefined && scheduleKind !== "stream") {
    return false;
  }
  // command/cwd may arrive without kind on an update and inherit a stored
  // stream schedule. Treat them as stream-authoring until current state proves
  // otherwise; create inputs use the kind-specific classifier above.
  return (
    scheduleKind === "stream" ||
    Object.hasOwn(schedule, "command") ||
    Object.hasOwn(schedule, "cwd")
  );
}

function cronPatchClearsStreamRestartExhaustion(patch: Record<string, unknown>): boolean {
  const state = isRecord(patch.state) ? patch.state : undefined;
  return state?.streamRestartExhausted === false;
}

export function cronUpdateNeedsCurrentJobForStreamAuthority(
  patch: Record<string, unknown>,
): boolean {
  return (
    patch.enabled === true ||
    cronPatchClearsStreamRestartExhaustion(patch) ||
    cronMutationRequiresStreamExecAuthority(patch)
  );
}

/** Whether this update authors or activates a stream source relative to stored state. */
export function cronUpdateRequiresStreamExecAuthority(
  patch: Record<string, unknown>,
  currentJob: Record<string, unknown>,
): boolean {
  const currentSchedule = isRecord(currentJob.schedule) ? currentJob.schedule : undefined;
  const proposedSchedule = isRecord(patch.schedule) ? patch.schedule : undefined;
  const currentScheduleKind =
    typeof currentSchedule?.kind === "string"
      ? normalizeLowercaseStringOrEmpty(currentSchedule.kind)
      : undefined;
  const proposedScheduleKind =
    typeof proposedSchedule?.kind === "string"
      ? normalizeLowercaseStringOrEmpty(proposedSchedule.kind)
      : undefined;
  const targetsStream =
    proposedScheduleKind === "stream" ||
    (proposedScheduleKind === undefined && currentScheduleKind === "stream");
  // Any explicit enable can clear exhaustion at commit time. Runtime state is
  // not part of configRevision, so authorize this independent of the earlier
  // state read to close the read/commit exhaustion race.
  const activatesStoredStream = patch.enabled === true && targetsStream;
  const recoversStoredStream = cronPatchClearsStreamRestartExhaustion(patch) && targetsStream;
  const replacementChangesStreamSource = (() => {
    if (proposedSchedule === undefined || !targetsStream) {
      return false;
    }
    if (proposedScheduleKind !== "stream" || currentScheduleKind !== "stream") {
      return !isDeepStrictEqual(proposedSchedule, currentSchedule);
    }
    if (!isCronStreamSchedule(proposedSchedule) || !isCronStreamSchedule(currentSchedule)) {
      return true;
    }
    return cronStreamScheduleKey(proposedSchedule) !== cronStreamScheduleKey(currentSchedule);
  })();
  const authorsStream =
    cronMutationRequiresStreamExecAuthority(patch) && replacementChangesStreamSource;
  return activatesStoredStream || recoversStoredStream || authorsStream;
}
