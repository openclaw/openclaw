import { randomUUID } from "node:crypto";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { bindSessionEntryPublicationSource } from "./session-accessor.sqlite-entry-cache-publication.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import type { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { runSessionCollaborationWrite } from "./session-sharing-store.async.js";
import type {
  addSessionSuggestion,
  claimSessionSuggestionDispatch,
  finalizeSessionSuggestionClaim,
  releaseSessionSuggestionDispatch,
} from "./session-suggestion-store.js";

export function assignSessionOwnerInWorker(
  scope: SessionCollaborationScope,
  params: Omit<Parameters<typeof assignSessionOwner>[1], "assertCurrent" | "expectedSessionId"> & {
    expectedSessionId: string;
  },
  assertCurrent?: () => void,
): Promise<ReturnType<typeof assignSessionOwner>> {
  const capturedParams = structuredClone({
    ...params,
    assignedAt: params.assignedAt ?? Date.now(),
  });
  return runSessionCollaborationWrite(
    scope,
    { type: "owner.assign", input: { scope, params: capturedParams } },
    (result, location, database, currentKeys) => {
      if (result.value && (!currentKeys || currentKeys.has(location.sessionKey))) {
        if (!database) {
          sessionChanges.emit(
            result.facts
              ? { ...location, facts: result.facts }
              : { ...location, factsInvalidated: true },
          );
        } else if (result.facts) {
          publishSessionEntryCacheInvalidation(
            { ...database, agentId: location.agentId },
            { sessionKey: location.sessionKey, facts: result.facts },
          );
        } else {
          sessionChanges.emit(
            bindSessionEntryPublicationSource({ ...location, factsInvalidated: true }, database),
            database.db,
          );
        }
      }
      return result.value;
    },
    assertCurrent,
  );
}

export function addSessionSuggestionInWorker(
  scope: SessionCollaborationScope,
  params: Parameters<typeof addSessionSuggestion>[1],
  assertCurrent?: () => void,
): Promise<ReturnType<typeof addSessionSuggestion>> {
  const capturedParams = structuredClone({
    ...params,
    id: params.id ?? randomUUID(),
    createdAt: params.createdAt ?? Date.now(),
  });
  return runSessionCollaborationWrite(
    scope,
    { type: "suggestion.add", input: { scope, params: capturedParams } },
    (result) => result,
    assertCurrent,
  );
}

export function claimSessionSuggestionDispatchInWorker(
  scope: SessionCollaborationScope,
  params: Parameters<typeof claimSessionSuggestionDispatch>[1],
  assertCurrent?: () => void,
): Promise<ReturnType<typeof claimSessionSuggestionDispatch>> {
  const capturedParams = structuredClone(params);
  return runSessionCollaborationWrite(
    scope,
    { type: "suggestion.claim", input: { scope, params: capturedParams } },
    (result) => result,
    assertCurrent,
  );
}

export function releaseSessionSuggestionDispatchInWorker(
  scope: SessionCollaborationScope,
  params: Parameters<typeof releaseSessionSuggestionDispatch>[1],
  assertCurrent?: () => void,
): Promise<ReturnType<typeof releaseSessionSuggestionDispatch>> {
  const capturedParams = structuredClone(params);
  return runSessionCollaborationWrite(
    scope,
    { type: "suggestion.release", input: { scope, params: capturedParams } },
    (result) => result,
    assertCurrent,
  );
}

export function finalizeSessionSuggestionClaimInWorker(
  scope: SessionCollaborationScope,
  params: Parameters<typeof finalizeSessionSuggestionClaim>[1],
  assertCurrent?: () => void,
): Promise<ReturnType<typeof finalizeSessionSuggestionClaim>> {
  const capturedParams = structuredClone(params);
  return runSessionCollaborationWrite(
    scope,
    { type: "suggestion.finalize", input: { scope, params: capturedParams } },
    (result) => result,
    assertCurrent,
  );
}
