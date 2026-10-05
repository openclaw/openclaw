import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { captureAgentDatabaseCloseFence } from "../../state/openclaw-agent-db-resources.js";
import {
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import type { IncognitoProjectionBinding } from "./session-incognito-projection.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import {
  captureSessionTranscriptReconcileGeneration,
  isSessionTranscriptReconcileGenerationCurrent,
} from "./session-transcript-reconcile-pool.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

export type SessionTranscriptReconcileParams = OpenClawAgentDatabaseOptions & {
  preferredSessionId?: string;
  assertCurrent?: () => void;
  signal?: AbortSignal;
};

export type PreparedReconcileParams = SessionTranscriptReconcileParams & {
  env: NodeJS.ProcessEnv;
  generation: number;
  incognito?: IncognitoProjectionBinding;
};
export function prepareReconcileParams(
  params: SessionTranscriptReconcileParams,
  incognito?: IncognitoProjectionBinding,
): PreparedReconcileParams {
  if (incognito) {
    getAsyncWorkSignal()?.throwIfAborted();
    incognito.actor.assertCurrent();
    incognito.authority.assertCurrent();
    if (
      incognito.actor.path !== resolveOpenClawAgentSqlitePath(params) ||
      incognito.actor.agentId !== params.agentId
    ) {
      throw new Error("Incognito reconciliation belongs to another actor");
    }
  }
  // Deferred work retains the state owner selected before scheduling or admission.
  return {
    ...params,
    env: { ...(params.env ?? process.env) },
    generation: captureSessionTranscriptReconcileGeneration(),
    incognito: incognito && { ...incognito, target: structuredClone(incognito.target) },
  };
}

/** Observe readiness without rebuilding or sweeping projections. */
export async function readSessionTranscriptProjectionStatus(
  databaseOptions: PreparedReconcileParams,
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  const { incognito } = databaseOptions;
  if (incognito) {
    const { actor, authority, target } = incognito;
    if (target && target.sessionId !== sessionId) {
      throw new Error("Incognito projection belongs to another session");
    }
    return actor.sessions.withCompute(
      authority,
      target,
      (compute) =>
        target
          ? compute.execute({ type: "session.compute.status", input: target })
          : compute.execute({ type: "session.compute.store.status", input: { sessionId } }),
      abortSignal,
    );
  }
  if (supportsOpenClawAgentDatabaseExecution(databaseOptions)) {
    const closing = captureAgentDatabaseCloseFence({
      agentId: databaseOptions.agentId,
      path: resolveOpenClawAgentSqlitePath(databaseOptions),
    });
    if (closing) {
      await racePromiseWithAbortSignal(closing, abortSignal);
      if (!isSessionTranscriptReconcileGenerationCurrent(databaseOptions.generation)) {
        return false;
      }
    }
    const execution = captureOpenClawAgentDatabaseExecution(databaseOptions);
    try {
      execution.assertCurrent();
      return await withSessionHistoryWorkerDatabase(databaseOptions, (owner) =>
        owner.readProjectionStatus({ env: databaseOptions.env, sessionId }, abortSignal),
      );
    } finally {
      await execution.release();
    }
  }
  const pending = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => sessionTranscriptIndexNeedsReconcile(db, sessionId),
    databaseOptions,
  );
  return pending.found && pending.value;
}
