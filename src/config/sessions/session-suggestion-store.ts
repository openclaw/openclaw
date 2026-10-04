import { randomUUID } from "node:crypto";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { sessionMetadataExpectedEntryMatches } from "./session-accessor.sqlite-owner.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type {
  SessionMetadataExpectedEntry,
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
import { SessionWorkStartInvalidatedError } from "./work-start-error.js";

export type { StoredSessionSuggestion } from "./session-sharing-store.types.js";
export { SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS } from "./session-suggestion-store.kernel.js";

function resolveDatabaseOptions(scope: SessionAccessScope): OpenClawAgentDatabaseOptions {
  return toDatabaseOptions(resolveSqliteScope(scope));
}

function assertSuggestionExpectedEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  expectedEntry: SessionMetadataExpectedEntry | undefined,
  options: OpenClawAgentDatabaseOptions,
): void {
  if (
    expectedEntry &&
    !sessionMetadataExpectedEntryMatches(database, sessionKey, expectedEntry, options)
  ) {
    throw new SessionWorkStartInvalidatedError("session changed before suggestion mutation");
  }
}

export function addSessionSuggestion(
  scope: SessionAccessScope,
  params: SessionSuggestionAddParams,
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
    (database) => {
      assertSuggestionExpectedEntry(database, sessionKey, params.expectedEntry, options);
      return addSessionSuggestionInDatabase(database, sessionKey, {
        suggestion,
        expectedSessionId: params.expectedSessionId,
      });
    },
    options,
    { operationLabel: "session.suggestion.add" },
  );
  return suggestion;
}

export function claimSessionSuggestionDispatch(
  scope: SessionAccessScope,
  params: SessionSuggestionClaimParams,
): ReturnType<typeof claimSessionSuggestionDispatchInDatabase> {
  const options = resolveDatabaseOptions(scope);
  const sessionKey = resolveSqliteScope(scope).sessionKey;
  return runOpenClawAgentWriteTransaction(
    (database) => {
      assertSuggestionExpectedEntry(database, sessionKey, params.expectedEntry, options);
      return claimSessionSuggestionDispatchInDatabase(database, sessionKey, params);
    },
    options,
    { operationLabel: "session.suggestion.claim" },
  );
}

export function releaseSessionSuggestionDispatch(
  scope: SessionAccessScope,
  params: SessionSuggestionReleaseParams,
): boolean {
  const options = resolveDatabaseOptions(scope);
  const sessionKey = resolveSqliteScope(scope).sessionKey;
  return runOpenClawAgentWriteTransaction(
    (database) => releaseSessionSuggestionDispatchInDatabase(database, sessionKey, params),
    options,
    { operationLabel: "session.suggestion.release" },
  );
}

export function finalizeSessionSuggestionClaim(
  scope: SessionAccessScope,
  params: SessionSuggestionFinalizeParams,
): StoredSessionSuggestion | null {
  const options = resolveDatabaseOptions(scope);
  const sessionKey = resolveSqliteScope(scope).sessionKey;
  return runOpenClawAgentWriteTransaction(
    (database) => {
      assertSuggestionExpectedEntry(database, sessionKey, params.expectedEntry, options);
      return finalizeSessionSuggestionClaimInDatabase(database, sessionKey, params);
    },
    options,
    { operationLabel: "session.suggestion.finalize" },
  );
}
