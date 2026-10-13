import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type {
  SessionSuggestionAddParams,
  SessionSuggestionClaimParams,
  SessionSuggestionFinalizeParams,
  SessionSuggestionReleaseParams,
  StoredSessionSuggestion,
} from "./session-sharing-store.types.js";
import {
  addSessionSuggestionInDatabase,
  claimSessionSuggestionDispatchInDatabase,
  finalizeSessionSuggestionClaimInDatabase,
  releaseSessionSuggestionDispatchInDatabase,
} from "./session-suggestion-store.kernel.js";

export type { StoredSessionSuggestion } from "./session-sharing-store.types.js";
export { SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS } from "./session-suggestion-store.kernel.js";

export function addSessionSuggestion(
  scope: SessionAccessScope,
  params: SessionSuggestionAddParams,
): StoredSessionSuggestion {
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const { sessionKey } = resolved;
  return runOpenClawAgentWriteTransaction(
    (database) => addSessionSuggestionInDatabase(database, sessionKey, params, options),
    options,
    { operationLabel: "session.suggestion.add" },
  );
}

export function claimSessionSuggestionDispatch(
  scope: SessionAccessScope,
  params: SessionSuggestionClaimParams,
): ReturnType<typeof claimSessionSuggestionDispatchInDatabase> {
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const { sessionKey } = resolved;
  return runOpenClawAgentWriteTransaction(
    (database) => claimSessionSuggestionDispatchInDatabase(database, sessionKey, params, options),
    options,
    { operationLabel: "session.suggestion.claim" },
  );
}

export function releaseSessionSuggestionDispatch(
  scope: SessionAccessScope,
  params: SessionSuggestionReleaseParams,
): boolean {
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const { sessionKey } = resolved;
  return runOpenClawAgentWriteTransaction(
    (database) => releaseSessionSuggestionDispatchInDatabase(database, sessionKey, params, options),
    options,
    { operationLabel: "session.suggestion.release" },
  );
}

export function finalizeSessionSuggestionClaim(
  scope: SessionAccessScope,
  params: SessionSuggestionFinalizeParams,
): StoredSessionSuggestion | null {
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const { sessionKey } = resolved;
  return runOpenClawAgentWriteTransaction(
    (database) => finalizeSessionSuggestionClaimInDatabase(database, sessionKey, params, options),
    options,
    { operationLabel: "session.suggestion.finalize" },
  );
}
