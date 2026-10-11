import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  SessionMaintenanceMetadataResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import type {
  SessionLifecycleProjectionCommit,
  SessionLifecycleProjectionCommitted,
} from "./session-lifecycle-projection.types.js";
import type { SessionLifecyclePlanningOperations } from "./session-lifecycle-projection.worker.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

type SessionLifecyclePlanningOwner = {
  database: ReclamationDatabaseOptions;
  execution: OpenClawAgentDatabaseExecution;
};

function runSessionLifecyclePlanningInWorker<Key extends keyof SessionLifecyclePlanningOperations>(
  params: SessionLifecyclePlanningOwner,
  type: Key,
  input: SessionLifecyclePlanningOperations[Key]["input"],
): Promise<SessionLifecyclePlanningOperations[Key]["output"]> {
  return withSessionEntryWorker(
    params.database,
    undefined,
    () => params.execution.assertCurrent(),
    async (execution, source) => {
      const result = await execution.runExisting(source, async (worker) => ({
        value: await executeOpenClawAgentWorkerPublication<SessionLifecyclePlanningOperations, Key>(
          worker,
          {
            id: randomUUID(),
            moduleUrl: resolveRuntimeWorkerUrl(
              runtimeProcessEntrypoints.sessionLifecyclePlanningDomain,
            ).href,
            input: { agentId: params.database.agentId },
            command: { type, input },
          },
        ),
      }));
      if (!result) {
        throw new Error("Session database disappeared before lifecycle planning");
      }
      return result.value;
    },
    undefined,
    params.execution,
  );
}

export function readSessionEntryLifecycleCountInWorker(params: SessionLifecyclePlanningOwner) {
  return runSessionLifecyclePlanningInWorker(params, "count", undefined);
}

/** Keep builders outside SQL while retaining the caller's physical FIFO and exact source. */
export async function projectSessionEntryLifecycleMutationInWorker(
  params: SessionLifecyclePlanningOwner & {
    input: LifecycleRemovalProjectionInput;
    upserts: readonly SessionEntryLifecycleUpsert[];
  },
) {
  const prepared = await runSessionLifecyclePlanningInWorker(params, "prepare", {
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
  return runSessionLifecyclePlanningInWorker(params, "finish", {
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
    | SessionLifecycleProjectionCommitted["result"]
    | Extract<SessionMaintenanceMetadataResult, { kind: "maintenance-preservation-required" }>
  >({
    database: params.database,
    agentId: params.input.agentId,
    assertCurrent: params.assertCurrent,
    assertPrepared: params.assertPrepared,
    assertCandidate: params.assertCandidate,
    retainedExecution: params.execution,
    candidateKind: "session-lifecycle-projection",
    readRolledBackResult: (value) =>
      isRecord(value) && value.kind === "maintenance-preservation-required"
        ? { value: { kind: "maintenance-preservation-required" } }
        : undefined,
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
