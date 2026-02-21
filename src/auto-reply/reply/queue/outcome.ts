import crypto from "node:crypto";
import type { FollowupQueueOutcomeStatus } from "../../types.js";
import type { FollowupRun } from "./types.js";

export function resolveQueueOutcomeRunId(run: FollowupRun): string {
  const existing = run.run.runId?.trim();
  if (existing) {
    return existing;
  }
  const generated = crypto.randomUUID();
  run.run.runId = generated;
  return generated;
}

export function emitFollowupQueueOutcome(
  run: FollowupRun,
  status: FollowupQueueOutcomeStatus,
  reason: string,
): void {
  const handler = run.onQueueOutcome;
  if (!handler) {
    return;
  }

  let maybePromise: Promise<void> | void;
  try {
    maybePromise = handler({
      runId: resolveQueueOutcomeRunId(run),
      status,
      reason,
    });
  } catch {
    return;
  }

  if (maybePromise && typeof (maybePromise as PromiseLike<unknown>).then === "function") {
    void maybePromise.catch(() => {});
  }
}
