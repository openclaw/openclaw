import { listUpdateRuns, recordUpdateRunVerification } from "./update-run-ledger.js";
import type { UpdateNormalCycleOptions } from "./update-run-normal-cycle.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { isUpdateRunNormalCycleAwaiting } from "./update-run-verification.js";

const DEFAULT_UPDATE_NORMAL_CYCLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function findNormalCycleCandidate(
  options: UpdateNormalCycleOptions,
  nowMs: number,
  maxAgeMs: number,
): UpdateRunRecord | undefined {
  const runs = listUpdateRuns({ limit: 32 }, options);
  // Never promote an older run while a newer update is still active.
  if (runs.some((run) => run.status === "running")) {
    return undefined;
  }
  const candidate = runs.find((run) => run.status !== "skipped" && run.phase === "finished");
  return candidate && isUpdateRunNormalCycleAwaiting(candidate, nowMs, maxAgeMs)
    ? candidate
    : undefined;
}

export function recordLatestUpdateRunNormalCycle(
  options: UpdateNormalCycleOptions = {},
): UpdateRunRecord | undefined {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_UPDATE_NORMAL_CYCLE_MAX_AGE_MS;
  const candidate = findNormalCycleCandidate(options, nowMs, maxAgeMs);
  if (!candidate) {
    return undefined;
  }
  return recordUpdateRunVerification(
    candidate.runId,
    { normalCycle: { status: "pass", observedAtMs: nowMs } },
    options,
  );
}

export function getLatestUpdateRunAwaitingNormalCycle(
  options: UpdateNormalCycleOptions = {},
): UpdateRunRecord | undefined {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_UPDATE_NORMAL_CYCLE_MAX_AGE_MS;
  return findNormalCycleCandidate(options, nowMs, maxAgeMs);
}
