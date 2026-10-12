import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";

export function createSessionCompoundWorkerFixture() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = {
    agentId: "main",
    storePath: database.path,
    sessionKey: "agent:main:compound-worker",
    sessionId: "original",
  };
  replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1, label: "initial" });
  return {
    database,
    scope,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    read: () => readExactSessionEntryRow(database, scope.sessionKey)?.entry,
    events: () =>
      readTranscriptEventRows(database, scope.sessionId).map((row) => JSON.parse(row.eventJson)),
  };
}
