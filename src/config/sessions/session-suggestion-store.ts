import { randomUUID } from "node:crypto";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  addSessionSuggestionInDatabase,
  claimSessionSuggestionDispatchInDatabase,
  finalizeSessionSuggestionClaimInDatabase,
  listSessionSuggestionsInDatabase,
  releaseSessionSuggestionDispatchInDatabase,
  type StoredSessionSuggestion,
} from "./session-suggestion-store.kernel.js";

export {
  SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
  type StoredSessionSuggestion,
} from "./session-suggestion-store.kernel.js";

function resolveDatabaseOptions(scope: SessionAccessScope): OpenClawAgentDatabaseOptions {
  return toDatabaseOptions(resolveSqliteScope(scope));
}

export function addSessionSuggestion(
  scope: SessionAccessScope,
  params: {
    authorId: string;
    authorLabel?: string;
    text: string;
    createdAt?: number;
    id?: string;
    expectedSessionId?: string;
  },
): StoredSessionSuggestion {
  const authorId = params.authorId.trim();
  const authorLabel = params.authorLabel?.trim() || undefined;
  const text = params.text;
  if (!authorId || !text.trim()) {
    throw new Error("suggestion author and text are required");
  }
  const options = resolveDatabaseOptions(scope);
  const sessionKey = resolveSqliteScope(scope).sessionKey;
  const suggestion: StoredSessionSuggestion & { state: "pending" } = {
    id: params.id ?? randomUUID(),
    authorId,
    ...(authorLabel ? { authorLabel } : {}),
    text,
    createdAt: params.createdAt ?? Date.now(),
    state: "pending",
  };
  runOpenClawAgentWriteTransaction(
    (database) =>
      addSessionSuggestionInDatabase(database, sessionKey, {
        suggestion,
        expectedSessionId: params.expectedSessionId,
      }),
    options,
  );
  return suggestion;
}

export function listSessionSuggestions(
  scope: SessionAccessScope,
  params: Parameters<typeof listSessionSuggestionsInDatabase>[2] = {},
): StoredSessionSuggestion[] {
  const options = resolveDatabaseOptions(scope);
  const database = openOpenClawAgentDatabase(options);
  const sessionKey = resolveSqliteScope(scope).sessionKey;
  return listSessionSuggestionsInDatabase(database, sessionKey, params);
}

export function claimSessionSuggestionDispatch(
  scope: SessionAccessScope,
  params: Parameters<typeof claimSessionSuggestionDispatchInDatabase>[2],
): ReturnType<typeof claimSessionSuggestionDispatchInDatabase> {
  const options = resolveDatabaseOptions(scope);
  const sessionKey = resolveSqliteScope(scope).sessionKey;
  return runOpenClawAgentWriteTransaction(
    (database) => claimSessionSuggestionDispatchInDatabase(database, sessionKey, params),
    options,
  );
}

export function releaseSessionSuggestionDispatch(
  scope: SessionAccessScope,
  params: Parameters<typeof releaseSessionSuggestionDispatchInDatabase>[2],
): boolean {
  const options = resolveDatabaseOptions(scope);
  const sessionKey = resolveSqliteScope(scope).sessionKey;
  return runOpenClawAgentWriteTransaction(
    (database) => releaseSessionSuggestionDispatchInDatabase(database, sessionKey, params),
    options,
  );
}

export function finalizeSessionSuggestionClaim(
  scope: SessionAccessScope,
  params: Parameters<typeof finalizeSessionSuggestionClaimInDatabase>[2],
): StoredSessionSuggestion | null {
  const options = resolveDatabaseOptions(scope);
  const sessionKey = resolveSqliteScope(scope).sessionKey;
  return runOpenClawAgentWriteTransaction(
    (database) => finalizeSessionSuggestionClaimInDatabase(database, sessionKey, params),
    options,
  );
}
