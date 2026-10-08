import { randomUUID } from "node:crypto";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { executeOpenClawAgentWorkerPublication } from "../../state/openclaw-agent-worker-store.js";
import type { SessionEntryLifecycleUpsert } from "./session-accessor.lifecycle-types.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import { buildProjectedLifecycleUpserts } from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  LifecycleRemovalProjectionInput,
  ReclamationDatabaseOptions,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import type {
  SessionLifecycleProjectionCommit,
  SessionLifecycleProjectionCommitted,
} from "./session-lifecycle-projection.types.js";
import type { SessionLifecyclePlanningOperations } from "./session-lifecycle-projection.worker.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

/** Keep builders outside SQL while retaining the caller's physical FIFO and exact source. */
export async function projectSessionEntryLifecycleMutationInWorker(params: {
  database: ReclamationDatabaseOptions;
  input: LifecycleRemovalProjectionInput;
  upserts: readonly SessionEntryLifecycleUpsert[];
  execution: OpenClawAgentDatabaseExecution;
}) {
  const run = <Key extends keyof SessionLifecyclePlanningOperations>(
    type: Key,
    input: SessionLifecyclePlanningOperations[Key]["input"],
  ): Promise<SessionLifecyclePlanningOperations[Key]["output"]> =>
    withSessionEntryWorker(
      params.database,
      undefined,
      () => params.execution.assertCurrent(),
      async (execution, source) => {
        const result = await execution.runExisting(source, async (worker) => ({
          value: await executeOpenClawAgentWorkerPublication<
            SessionLifecyclePlanningOperations,
            Key
          >(worker, {
            id: randomUUID(),
            moduleUrl: resolveRuntimeWorkerUrl(
              runtimeProcessEntrypoints.sessionLifecyclePlanningDomain,
            ).href,
            input: { agentId: params.database.agentId },
            command: { type, input },
          }),
        }));
        if (!result) {
          throw new Error("Session database disappeared before lifecycle planning");
        }
        return result.value;
      },
      undefined,
      params.execution,
    );
  const prepared = await run("prepare", {
    ...params.input,
    upsertSessionKeys: params.upserts.map((upsert) => upsert.sessionKey.trim()),
  });
  const upsertedEntries = await buildProjectedLifecycleUpserts(
    prepared.store,
    prepared.selected,
    params.upserts,
  );
  params.execution.assertCurrent();
  if (prepared.selected.projectedRemovals.length === 0) {
    return {
      deletePlans: [],
      removals: [],
      upsertedEntries,
      archiveRecovery: prepared.archiveRecovery,
    };
  }
  return run("finish", {
    ...prepared,
    upsertedEntries,
    archiveDirectory: params.input.archiveDirectory,
  });
}

export function commitSessionLifecycleProjectionInWorker(params: {
  database: ReclamationDatabaseOptions;
  input: SessionLifecycleProjectionCommit;
  execution: OpenClawAgentDatabaseExecution;
  assertCurrent: () => void;
  assertPrepared: () => void;
  assertCandidate: (candidate: SessionLifecycleProjectionCommitted) => void;
  onLifecycleCommitted?: () => void;
}) {
  return runSessionEntryWorkerOperation<
    SessionLifecycleProjectionCommitted,
    SessionLifecycleProjectionCommitted["result"]
  >({
    database: params.database,
    agentId: params.input.agentId,
    assertCurrent: params.assertCurrent,
    assertPrepared: params.assertPrepared,
    assertCandidate: params.assertCandidate,
    retainedExecution: params.execution,
    candidateKind: "session-lifecycle-projection",
    run: (worker, commit) =>
      commit(() => worker.execute({ type: "session.lifecycle.project", input: params.input })),
    onAcknowledged(candidate) {
      params.onLifecycleCommitted?.();
      for (const sessionId of candidate.projectionReconcileSessionIds) {
        startSessionTranscriptIndexReconcile({ ...params.database, preferredSessionId: sessionId });
      }
    },
    onCommitted(candidate, published, identity) {
      for (const sessionKey of candidate.progressCardResetKeys) {
        emitSessionLifecycleEvent({
          agentId: params.input.agentId,
          sessionKey,
          reason: "progress-card-reset",
        });
      }
      if (published) {
        publishCommittedSessionIdentity(
          params.input.agentId,
          identity,
          published.previous,
          published.current,
          published.prepared,
        );
      }
      return candidate.result;
    },
  });
}
