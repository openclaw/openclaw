// Cron observations use the registry's worker snapshot and existing query policies.
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import {
  countActiveDescendantRunsFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
  listDescendantRunsForRequesterFromRuns,
} from "../../agents/subagents/registry/subagent-registry-queries.js";
import {
  prepareSubagentRunsSnapshotForSessions,
  withSubagentRunReadSnapshot,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { collectSubagentSessionReadKeys } from "../../agents/subagents/registry/subagent-session-read-scope.js";

function withCronDescendantRuns<T>(
  sessionKey: string,
  consume: (runs: Map<string, SubagentRunRecord>) => T,
): Promise<T> {
  return withSubagentRunReadSnapshot(
    subagentRuns,
    (snapshot) => {
      const sessionKeys = collectSubagentSessionReadKeys([sessionKey], snapshot.values());
      return {
        runIds: [...snapshot.values()]
          .filter((entry) => sessionKeys.has(entry.childSessionKey.trim()))
          .map((entry) => entry.runId),
        sessionKeys: [],
      };
    },
    (_selection, runs) => consume(new Map(runs)),
    { sessionKeys: [sessionKey], descendants: true },
  );
}

export function readDescendantExecutionState(sessionKey: string, runStartedAt: number) {
  return withCronDescendantRuns(sessionKey, (runs) => ({
    hasFreshDescendants: listDescendantRunsForRequesterFromRuns(runs, sessionKey).some((entry) => {
      const descendantStartedAt =
        typeof entry.execution.startedAt === "number" ? entry.execution.startedAt : entry.createdAt;
      return typeof descendantStartedAt === "number" && descendantStartedAt >= runStartedAt;
    }),
    hasActiveDescendants: countActiveDescendantRunsFromRuns(runs, sessionKey) > 0,
  }));
}

export function listDescendantRunsForRequester(sessionKey: string): Promise<SubagentRunRecord[]> {
  return withCronDescendantRuns(sessionKey, (runs) =>
    listDescendantRunsForRequesterFromRuns(runs, sessionKey),
  );
}

export function hasUnsettledCronDescendants(sessionKey: string): Promise<boolean> {
  return withCronDescendantRuns(sessionKey, (runs) =>
    hasDescendantRunAwaitingSettleFromRuns(runs, sessionKey),
  );
}

/** Retain live parent policy alongside the worker's durable deletion comparison. */
export async function prepareCronDescendantDeletion(sessionKeys: readonly string[]) {
  const prepared = await prepareSubagentRunsSnapshotForSessions(subagentRuns, sessionKeys);
  return {
    basis: prepared.basis,
    dispose: () => prepared.dispose(),
    hasUnsettled(sessionKey: string) {
      const current = prepared.consume((runs) =>
        hasDescendantRunAwaitingSettleFromRuns(new Map(runs), sessionKey),
      );
      if (!current.ready) {
        throw new Error("Cron descendant state changed during deletion preparation");
      }
      return current.value;
    },
  };
}
