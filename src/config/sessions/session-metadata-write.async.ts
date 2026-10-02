import { randomUUID } from "node:crypto";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { runSessionCollaborationWrite } from "./session-sharing-store.async.js";
import type { SessionSharingWorkerOperations } from "./session-sharing-store.types.js";
import {
  addSessionSuggestion,
  claimSessionSuggestionDispatch,
  finalizeSessionSuggestionClaim,
  releaseSessionSuggestionDispatch,
} from "./session-suggestion-store.js";

export function assignSessionOwnerInWorker(
  scope: SessionAccessScope,
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
    (capturedScope) => assignSessionOwner(capturedScope, capturedParams),
    (result, location, database) => {
      if (result.value) {
        if (result.facts) {
          publishSessionEntryCacheInvalidation(
            { ...database, agentId: location.agentId },
            { sessionKey: location.sessionKey, facts: result.facts },
          );
        } else {
          sessionChanges.emit({ ...location, factsInvalidated: true });
        }
      }
      return result.value;
    },
    assertCurrent,
  );
}

function createSessionSuggestionWrite<
  Key extends Extract<keyof SessionSharingWorkerOperations, `suggestion.${string}`>,
>(
  type: Key,
  native: (
    scope: SessionAccessScope,
    params: SessionSharingWorkerOperations[Key]["input"]["params"],
  ) => SessionSharingWorkerOperations[Key]["output"],
  prepare = (params: SessionSharingWorkerOperations[Key]["input"]["params"]) => params,
) {
  return (
    scope: SessionAccessScope,
    params: SessionSharingWorkerOperations[Key]["input"]["params"],
    assertCurrent?: () => void,
  ): Promise<SessionSharingWorkerOperations[Key]["output"]> => {
    const capturedParams = structuredClone(prepare(params));
    return runSessionCollaborationWrite(
      scope,
      { type, input: { scope, params: capturedParams } },
      (capturedScope) => native(capturedScope, capturedParams),
      (result) => result,
      assertCurrent,
    );
  };
}

export const addSessionSuggestionInWorker = createSessionSuggestionWrite(
  "suggestion.add",
  addSessionSuggestion,
  (params) => ({
    ...params,
    id: params.id ?? randomUUID(),
    createdAt: params.createdAt ?? Date.now(),
  }),
);
export const claimSessionSuggestionDispatchInWorker = createSessionSuggestionWrite(
  "suggestion.claim",
  claimSessionSuggestionDispatch,
);
export const releaseSessionSuggestionDispatchInWorker = createSessionSuggestionWrite(
  "suggestion.release",
  releaseSessionSuggestionDispatch,
);
export const finalizeSessionSuggestionClaimInWorker = createSessionSuggestionWrite(
  "suggestion.finalize",
  finalizeSessionSuggestionClaim,
);
