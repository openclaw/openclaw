import path from "node:path";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { listSessionPendingInputReceipts } from "./session-accessor.sqlite-pending-input-receipts.js";
import { prepareSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Reconcile exact run receipts without reading pending input payloads on the Gateway. */
export async function readSessionPendingInputReceiptsInWorker(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  options: { runIds: readonly string[] },
): Promise<ReturnType<typeof listSessionPendingInputReceipts>> {
  if (options.runIds.length === 0) {
    return [];
  }
  const authority = { assertCurrent() {}, authorize() {} };
  const memory = captureSessionActorStorageOwner(scope, authority);
  if (memory) {
    return (
      (await withSessionActorStorage(
        scope,
        {
          lifetime: { assertCurrent() {}, assertReadable() {} },
          authority: memory.authority,
        },
        (binding) =>
          binding.actor.storage.read(
            {
              type: "session.pendingInput.receipts",
              input: {
                sessionKey: scope.sessionKey,
                sessionId: scope.sessionId,
                runIds: options.runIds,
              },
            },
            binding.authority,
          ),
      )) ?? []
    );
  }
  const captured = {
    ...scope,
    ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const runIds = [...options.runIds];
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
