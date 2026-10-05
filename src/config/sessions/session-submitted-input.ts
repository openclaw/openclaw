import path from "node:path";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { readSessionSubmittedInput } from "./session-accessor.pending-inputs.js";
import { prepareSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Read one exact accepted source, including input not yet promoted to model history. */
export async function readSessionSubmittedRunInputInWorker(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  runId: string,
): Promise<ReturnType<typeof readSessionSubmittedInput>> {
  const captured = {
    ...scope,
    ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  if (isIncognitoSessionKey(captured.sessionKey)) {
    const { readSessionSubmittedInput } = await import("./session-accessor.pending-inputs.js");
    return (
      readSessionSubmittedInput(captured, `${runId}:user`, { requireReadSuccess: true }) ??
      readSessionSubmittedInput(captured, runId, { requireReadSuccess: true })
    );
  }
  const context = captureOpenClawStateReadWorkerContext({ env: captured.env });
  const assertCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  const resolved = await prepareSqliteScope(captured);
  assertCurrent();
  const databaseOptions = toDatabaseOptions(resolved);
  return withSessionHistoryWorkerDatabase(
    {
      ...databaseOptions,
      path: resolveOpenClawAgentSqlitePath(databaseOptions),
    },
    async (owner) => {
      const message = await owner.readSubmittedInput({
        agentId: resolved.agentId,
        sessionKey: resolved.sessionKey,
        sessionId: captured.sessionId,
        runId,
        env: captured.env,
      });
      assertCurrent();
      return message;
    },
  );
}
