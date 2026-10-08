import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";

export function createSessionEntryPatchFixture() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = {
    agentId: "main",
    storePath: database.path,
    sessionKey: "agent:main:patch-worker",
  };
  replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1, label: "initial" });
  return {
    database,
    scope,
    read: () => readExactSessionEntryRow(database, scope.sessionKey)?.entry,
  };
}
