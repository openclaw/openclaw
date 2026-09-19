import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";

/** Defers participant history persistence so it can never delay or abort an admitted turn. */
export function recordSessionParticipantBestEffort(params: {
  identity: SessionParticipantIdentity;
  agentId: string;
  sessionKey: string;
  storePath: string;
  promptedAt?: number;
  onError?: (error: unknown) => void;
}): void {
  const promptedAt = params.promptedAt ?? Date.now();
  void Promise.resolve()
    .then(() => {
      const scope = {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        env: cloneEnvWithPlatformSemantics(process.env),
      };
      return withOpenClawAgentDatabaseWrite(
        toDatabaseOptions(resolveSqliteScope(scope)),
        (database) =>
          recordSessionParticipant(
            { ...scope, storePath: database.path },
            {
              identity: params.identity,
              promptedAt,
              sessionAgentId: params.agentId,
            },
          ),
      );
    })
    .catch((error: unknown) => params.onError?.(error));
}
