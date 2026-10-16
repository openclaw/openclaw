import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
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
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

export type SessionTranscriptReconcileParams = OpenClawAgentDatabaseOptions & {
  preferredSessionId?: string;
  assertCurrent?: () => void;
  signal?: AbortSignal;
};

export type PreparedReconcileParams = SessionTranscriptReconcileParams & {
  env: NodeJS.ProcessEnv;
};
export function prepareReconcileParams(
  params: SessionTranscriptReconcileParams,
): PreparedReconcileParams {
  const path = resolveOpenClawAgentSqlitePath(params);
  // Deferred work retains the state owner selected before scheduling or admission.
  return {
    ...params,
    path,
    env: { ...(params.env ?? process.env) },
  };
}

/** Observe readiness without rebuilding or sweeping projections. */
export async function readSessionTranscriptProjectionStatus(
  databaseOptions: PreparedReconcileParams,
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (supportsOpenClawAgentDatabaseExecution(databaseOptions)) {
    const closing = captureAgentDatabaseCloseFence({
      agentId: databaseOptions.agentId,
      path: resolveOpenClawAgentSqlitePath(databaseOptions),
    });
    if (closing) {
      await racePromiseWithAbortSignal(closing, abortSignal);
      // A probe in the retiring lifetime must not reopen resources after close.
      return false;
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
