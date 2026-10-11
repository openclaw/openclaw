import { isIncognitoSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureSessionEntryReadScope } from "./session-entry-read-request.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

/** Diagnostic identities name the default agent store, not a logical store locator. */
export async function withSessionDiagnosticTextInWorker(
  input: { agentId: string; sessionKey: string; sessionId: string },
  assertCurrent: () => void,
  consume: (text: string | undefined) => void,
): Promise<void> {
  const { scope, env } = captureSessionEntryReadScope(input);
  const agentId = normalizeAgentId(input.agentId);
  assertCurrent();
  if (isIncognitoSessionKey(scope.sessionKey)) {
    consume(undefined);
    return;
  }
  const storePath = resolveOpenClawAgentSqlitePath({ agentId, env });
  const admission = resolveSessionTranscriptReadFence(input);
  await withSessionHistoryWorkerDatabase(
    { agentId, path: storePath, env },
    async (owner) => {
      assertCurrent();
      const text = await owner.readDiagnosticText({
        scope: {
          ...scope,
          agentId,
          databaseAgentId: agentId,
          storePath,
          sessionId: input.sessionId,
        },
        admission,
      });
      owner.assertCurrent();
      assertCurrent();
      consume(text);
    },
    maintenanceLane,
  );
}
