import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { captureAgentDatabaseCloseFence } from "../../state/openclaw-agent-db-resources.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { isSessionTranscriptReconcileGenerationCurrent } from "./session-transcript-reconcile-pool.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

/** Keep readiness reads with the same physical store and generation as the scheduled owner. */
export function createSessionProjectionReadinessProbe(params: {
  databaseOptions: OpenClawAgentDatabaseOptions & { env: NodeJS.ProcessEnv; generation: number };
  databasePath: string;
  sessionId: string;
  abortSignal?: AbortSignal;
}): () => Promise<boolean> {
  const { databaseOptions, databasePath, sessionId, abortSignal } = params;
  if (supportsOpenClawAgentDatabaseExecution(databaseOptions)) {
    return async () => {
      const closing = captureAgentDatabaseCloseFence({
        agentId: databaseOptions.agentId,
        path: databasePath,
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
    };
  }
  return async () => {
    const pending = withOpenClawAgentDatabaseReadOnly(
      ({ db }) => sessionTranscriptIndexNeedsReconcile(db, sessionId),
      databaseOptions,
    );
    return pending.found && pending.value;
  };
}
