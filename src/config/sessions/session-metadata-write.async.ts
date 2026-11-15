import { randomUUID } from "node:crypto";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import type { SessionOwnerAssignment } from "./session-entry-provenance.js";
import {
  publishSessionCollaborationChanges,
  runSessionCollaborationWrite,
} from "./session-sharing-store.async.js";
import type {
  SessionOwnerAssignParams,
  SessionSuggestionAddParams,
  SessionSuggestionClaimParams,
  SessionSuggestionDispatchClaim,
  SessionSuggestionFinalizeParams,
  SessionSuggestionReleaseParams,
  StoredSessionSuggestion,
} from "./session-sharing-store.types.js";

export function assignSessionOwnerInWorker(
  scope: SessionCollaborationScope,
  params: Omit<SessionOwnerAssignParams, "expectedSessionId"> & {
    expectedSessionId: string;
  },
  assertCurrent?: () => void,
): Promise<SessionOwnerAssignment | null> {
  const capturedParams = structuredClone({
    ...params,
    assignedAt: params.assignedAt ?? Date.now(),
  });
  return runSessionCollaborationWrite(
    scope,
    { type: "owner.assign", input: { scope, params: capturedParams } },
    (result, location, database, currentKeys) => {
      if (result.value && (!currentKeys || currentKeys.has(location.sessionKey))) {
        publishSessionCollaborationChanges(
          [
            result.facts
              ? { ...location, facts: result.facts }
              : { ...location, factsInvalidated: true },
          ],
          database,
        );
      }
      return result.value;
    },
    assertCurrent,
  );
}

export function addSessionSuggestionInWorker(
  scope: SessionCollaborationScope,
  params: SessionSuggestionAddParams,
  assertCurrent?: () => void,
): Promise<StoredSessionSuggestion> {
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
  params: SessionSuggestionClaimParams,
  assertCurrent?: () => void,
): Promise<SessionSuggestionDispatchClaim | null> {
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
  params: SessionSuggestionReleaseParams,
  assertCurrent?: () => void,
): Promise<boolean> {
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
  params: SessionSuggestionFinalizeParams,
  assertCurrent?: () => void,
): Promise<StoredSessionSuggestion | null> {
  const capturedParams = structuredClone(params);
  return runSessionCollaborationWrite(
    scope,
    { type: "suggestion.finalize", input: { scope, params: capturedParams } },
    (result) => result,
    assertCurrent,
  );
}
