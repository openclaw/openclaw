import type {
  SessionCompactionPlanRequest,
  SessionCompactionSourceConsumer,
  SessionCompactionSourceName,
} from "./session-compaction-source.types.js";
import type { SessionHistoryWorkerRequestRunner } from "./session-transcript-worker.types.js";

type PlanInput = Omit<SessionCompactionPlanRequest, "kind" | "database" | "phase">;

/**
 * One worker task plans compaction and returns payload-free selection facts.
 * Each summary input is then rendered by its own short task that rereads only
 * the selected rows of the captured transcript version, so no worker slot or
 * read snapshot is held while the Gateway waits for a summary model.
 */
export async function withSessionCompactionSource(
  runRequest: SessionHistoryWorkerRequestRunner,
  input: PlanInput,
  consume: SessionCompactionSourceConsumer,
  signal?: AbortSignal,
  timeoutMs = 600_000,
): Promise<string | undefined> {
  const planned = await runRequest(
    () => ({ kind: "compaction-source", phase: "plan", ...input }),
    JSON.stringify(input).length * 2,
    ({ reply }) => reply,
    signal,
    undefined,
    timeoutMs,
  );
  if (planned.kind === "skipped") {
    return planned.reason;
  }
  if (planned.kind !== "prepared") {
    throw new Error("Compaction source returned an unexpected plan reply");
  }
  const { plan, sources } = planned;
  const read = {
    target: input.target,
    resolvedScope: input.resolvedScope,
    expectedIdentity: input.expectedIdentity,
    version: plan.version,
  };
  const source = (name: SessionCompactionSourceName, length: number) => {
    const entries = sources[name];
    // Selection facts are fixed for the plan; size them once for every rendering.
    const inputBytes = (JSON.stringify(read).length + JSON.stringify(entries).length) * 2;
    return {
      length,
      serialize: (maxChars: number) =>
        runRequest(
          () => ({ kind: "compaction-source", phase: "serialize", ...read, entries, maxChars }),
          inputBytes,
          ({ reply }) => {
            if (reply.kind !== "serialized") {
              throw new Error("Compaction source returned an unexpected serialization reply");
            }
            return reply.conversation;
          },
          signal,
          undefined,
          timeoutMs,
        ),
    };
  };
  const { facts } = plan;
  await consume(plan, {
    ...facts,
    history: source("history", facts.historyCount),
    turnPrefix: source("turnPrefix", facts.turnPrefixCount),
    reconciliation: source("reconciliation", facts.reconciliationCount),
  });
  return undefined;
}
