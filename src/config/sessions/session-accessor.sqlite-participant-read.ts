import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  participantRecordsBySessionKey,
  type SessionParticipantRecord,
} from "./session-accessor.sqlite-participant-projection.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";

export function listSessionParticipantsReadOnly(scope: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  storePath?: string;
}): Map<string, SessionParticipantRecord[]> {
  const resolved = resolveSqliteReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      participantRecordsBySessionKey(
        database.db,
        scope.sessionKey ? [scope.sessionKey] : undefined,
      ),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : new Map();
}
