import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { listSessionReactionsInDatabase } from "./session-reaction-store.read.js";
import type { StoredMessageReactionSummary } from "./session-reaction-store.types.js";

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
