import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  participantRecordsBySessionKey,
  type SessionParticipantRecord,
} from "./session-accessor.sqlite-participant-projection.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";

export function listSessionParticipantsReadOnly(scope: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  storePath?: string;
}): Map<string, SessionParticipantRecord[]> {
  const memory = scope.sessionKey && getSessionActorStorageBinding(scope);
  if (memory) {
    return new Map([
      [
        scope.sessionKey!,
        structuredClone(memory.actor.snapshot(memory.authority)?.participants ?? []),
      ],
    ]);
  }
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
