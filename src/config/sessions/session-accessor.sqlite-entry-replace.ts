import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { replaceSessionEntryInDatabase } from "./session-accessor.sqlite-entry-mutation.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Native transcript commits must not load host actor acquisition and maintenance. */
export function replaceSessionEntrySync(scope: SessionAccessScope, entry: SessionEntry): void {
  const resolved = resolveSqliteScope(scope);
  assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
  const publish = runOpenClawAgentWriteTransaction(
    (database) => {
      const { previous, current } = replaceSessionEntryInDatabase(
        database,
        resolved.sessionKey,
        entry,
      );
      return prepareSessionIdentityPublication(database, resolved.agentId, previous, current);
    },
    toDatabaseOptions(resolved),
    { operationLabel: "session-entry.replace" },
  );
  publish();
}
