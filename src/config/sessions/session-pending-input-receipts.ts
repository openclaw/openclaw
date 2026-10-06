import path from "node:path";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { listSessionPendingInputReceipts } from "./session-accessor.sqlite-pending-input-receipts.js";
import { prepareSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
import {
  readIncognitoSessionHistory,
  type IncognitoSessionHistoryBinding,
} from "./session-incognito-history-read.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Reconcile exact run receipts without reading pending input payloads on the Gateway. */
export async function readSessionPendingInputReceiptsInWorker(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  options: { runIds: readonly string[] },
  incognito?: IncognitoSessionHistoryBinding,
): Promise<ReturnType<typeof listSessionPendingInputReceipts>> {
  const capturedActor = !incognito && captureIncognitoSessionOperation(scope);
  const binding = capturedActor
    ? {
        ...capturedActor,
        target: {
          sessionKey: scope.sessionKey,
          sessionId: scope.sessionId,
          lifecycleRevision: capturedActor.actor.sessions.readSharing(scope.sessionKey)?.entry
            ?.lifecycleRevision,
        },
      }
    : incognito;
  const boundScope = capturedActor ? { ...scope, storePath: capturedActor.actor.path } : scope;
  if (binding) {
    const result = await readIncognitoSessionHistory(binding, boundScope, (target) => ({
      type: "session.history.receipts",
      input: { ...target, runIds: options.runIds },
    }));
    return result.receipts;
  }
  if (options.runIds.length === 0) {
    return [];
  }
  const captured = {
    ...scope,
    ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const runIds = [...options.runIds];
  if (isIncognitoSessionKey(captured.sessionKey)) {
    // A process-owned in-memory store cannot be reopened in another worker.
    const { listSessionPendingInputReceipts } =
      await import("./session-accessor.sqlite-pending-input-receipts.js");
    return listSessionPendingInputReceipts(captured, { runIds });
  }
  const context = captureOpenClawStateReadWorkerContext({ env: captured.env });
  const assertStateCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  const resolved = await prepareSqliteScope(captured);
  assertStateCurrent();
  const databaseOptions = toDatabaseOptions(resolved);
  return await withSessionHistoryWorkerDatabase(
    { ...databaseOptions, path: resolveOpenClawAgentSqlitePath(databaseOptions) },
    async (owner) => {
      const receipts = await owner.readPendingInputReceipts({
        agentId: resolved.agentId,
        sessionKey: resolved.sessionKey,
        sessionId: captured.sessionId,
        runIds,
        env: captured.env,
      });
      assertStateCurrent();
      return receipts;
    },
  );
}
