import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  setSessionReactionInDatabase,
  type SessionReactionWrite,
  type SetSessionReactionParams,
} from "./session-reaction-store.kernel.js";
import { listSessionReactionsInDatabase } from "./session-reaction-store.read.js";
import type { StoredMessageReactionSummary } from "./session-reaction-store.types.js";

export {
  SessionReactionLimitError,
  SessionReactionMessageMissingError,
} from "./session-reaction-store.kernel.js";
export type { StoredMessageReactionSummary } from "./session-reaction-store.types.js";

export function setSessionReaction(
  scope: SessionAccessScope,
  params: SetSessionReactionParams,
): SessionReactionWrite {
  const resolved = resolveSqliteScope(scope);
  return runOpenClawAgentWriteTransaction(
    (database) => setSessionReactionInDatabase(database, resolved.sessionKey, params),
    toDatabaseOptions(resolved),
    { operationLabel: "session.reaction.set" },
  );
}

export function listSessionReactions(
  scope: SessionAccessScope,
  params: { sessionId: string },
): Record<string, StoredMessageReactionSummary[]> {
  const resolved = resolveSqliteScope(scope);
  return listSessionReactionsInDatabase(
    openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    resolved.sessionKey,
    params,
  );
}
