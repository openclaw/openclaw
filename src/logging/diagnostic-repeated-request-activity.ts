import { resolveCurrentDiagnosticRunId } from "./diagnostic-embedded-run-index.js";

// The first retry starts the clock; one long initial request is not a loop.
// Later retries share that clock until semantic progress or owner teardown.
type RepeatedRequestOwner = { runId: string; sequence: number };

export type DiagnosticRepeatedRequestActivity = {
  repeatedRequestOwnerRunId?: string;
  repeatedRequestFirstStartedAt?: number;
  repeatedRequestMutationSequence?: number;
};

let mutationSequence = 0;

export function recordRepeatedRequestObservation(
  activity: DiagnosticRepeatedRequestActivity,
  owners: Iterable<RepeatedRequestOwner>,
  params: {
    runId?: string;
    observationUnit?: "request" | "turn";
    now?: number;
  },
): void {
  if (params.observationUnit === "turn") {
    return;
  }
  const currentOwnerRunId = resolveCurrentDiagnosticRunId(owners);
  const runId = params.runId?.trim();
  if (currentOwnerRunId === undefined || !runId || currentOwnerRunId !== runId) {
    return;
  }
  if (activity.repeatedRequestOwnerRunId !== runId) {
    activity.repeatedRequestOwnerRunId = runId;
    activity.repeatedRequestFirstStartedAt = undefined;
  } else {
    activity.repeatedRequestFirstStartedAt ??= params.now ?? Date.now();
  }
  activity.repeatedRequestMutationSequence = ++mutationSequence;
}

export function clearRepeatedRequestActivity(
  activity: DiagnosticRepeatedRequestActivity,
  params: { runId?: string } = {},
): boolean {
  if (
    params.runId !== undefined &&
    activity.repeatedRequestOwnerRunId !== undefined &&
    activity.repeatedRequestOwnerRunId !== params.runId
  ) {
    return false;
  }
  const cleared = activity.repeatedRequestOwnerRunId !== undefined;
  if (!cleared && params.runId !== undefined) {
    return false;
  }
  activity.repeatedRequestOwnerRunId = undefined;
  activity.repeatedRequestFirstStartedAt = undefined;
  activity.repeatedRequestMutationSequence = ++mutationSequence;
  return cleared;
}

export function mergeRepeatedRequestActivity(
  target: DiagnosticRepeatedRequestActivity,
  source: DiagnosticRepeatedRequestActivity,
): void {
  if (
    source.repeatedRequestMutationSequence === undefined ||
    (target.repeatedRequestMutationSequence ?? 0) >= source.repeatedRequestMutationSequence
  ) {
    return;
  }
  target.repeatedRequestOwnerRunId = source.repeatedRequestOwnerRunId;
  target.repeatedRequestFirstStartedAt = source.repeatedRequestFirstStartedAt;
  target.repeatedRequestMutationSequence = source.repeatedRequestMutationSequence;
}

export function resolveRepeatedRequestNoProgressAgeMs(
  activity: DiagnosticRepeatedRequestActivity,
  currentOwnerRunId: string | undefined,
  now: number,
): number | undefined {
  if (
    currentOwnerRunId === undefined ||
    currentOwnerRunId !== activity.repeatedRequestOwnerRunId ||
    activity.repeatedRequestFirstStartedAt === undefined
  ) {
    return undefined;
  }
  return Math.max(0, now - activity.repeatedRequestFirstStartedAt);
}
