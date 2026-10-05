import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { isUpdateRunNormalCycleAwaiting } from "./update-run-verification.js";
import { recordUpdateRunNormalCycleAsync } from "./update-run-write.async.js";

const DEFAULT_UPDATE_NORMAL_CYCLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type UpdateNormalCycleOptions = OpenClawStateDatabaseOptions & {
  nowMs?: number;
  maxAgeMs?: number;
  signal?: AbortSignal;
  context?: OpenClawStateWorkerContext;
};

function isAwaitingNormalCycle(run: UpdateRunRecord, nowMs: number, maxAgeMs: number): boolean {
  return isUpdateRunNormalCycleAwaiting(run, nowMs, maxAgeMs);
}

async function listUpdateRunsForNormalCycle(
  context: OpenClawStateWorkerContext,
  signal?: AbortSignal,
): Promise<UpdateRunRecord[]> {
  const reply = await withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "updateRuns.list", input: { limit: 32 } },
      { context, signal, preferIndependentWarmRead: true },
    ),
  );
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "updateRuns.list") {
    throw new Error("Unexpected update run list result");
  }
  return reply.runs;
}

/** Worker-backed version used by the live Gateway callback. */
export async function recordLatestUpdateRunNormalCycleAsync(
  options: UpdateNormalCycleOptions = {},
): Promise<UpdateRunRecord | undefined> {
  const context = options.context ?? captureOpenClawStateWorkerContext(options);
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_UPDATE_NORMAL_CYCLE_MAX_AGE_MS;
  context.admission.assertCurrent();
  const runs = await listUpdateRunsForNormalCycle(context, options.signal);
  if (runs.some((run) => run.status === "running")) {
    return undefined;
  }
  const candidate = runs.find((run) => run.status !== "skipped" && run.phase === "finished");
  if (!candidate || !isAwaitingNormalCycle(candidate, nowMs, maxAgeMs)) {
    return undefined;
  }
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.signal?.throwIfAborted();
  };
  return await recordUpdateRunNormalCycleAsync(
    candidate.runId,
    { normalCycle: { status: "pass", observedAtMs: nowMs } },
    { nowMs, maxAgeMs },
    {
      ...options,
      context,
      assertCurrent,
    },
  );
}
