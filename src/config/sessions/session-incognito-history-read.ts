import path from "node:path";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import type { IncognitoSessionActor } from "./session-incognito-actor.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type { IncognitoHistoryTarget } from "./session-incognito-history-contract.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

export type IncognitoSessionHistoryBinding = {
  actor: IncognitoSessionActor;
  authority: IncognitoSessionAuthority;
  target: IncognitoHistoryTarget;
};

/** Inactive until atomic activation supplies the original actor instead of native routing. */
export function prepareIncognitoSessionHistoryRead(
  binding: IncognitoSessionHistoryBinding,
  scope: SessionTranscriptReadScope,
  signal?: AbortSignal,
) {
  const { actor, authority } = binding;
  const target = structuredClone(binding.target);
  if (
    scope.sessionId !== target.sessionId ||
    (scope.sessionKey !== undefined && scope.sessionKey !== target.sessionKey) ||
    (scope.agentId !== undefined && scope.agentId !== actor.agentId) ||
    (scope.storePath !== undefined && path.resolve(scope.storePath) !== actor.path) ||
    (scope.sessionEntry?.sessionId !== undefined &&
      scope.sessionEntry.sessionId !== target.sessionId)
  ) {
    throw new Error("Incognito history read belongs to another session or store");
  }
  const admission =
    target.admission ??
    resolveSessionTranscriptReadFence({
      agentId: actor.agentId,
      sessionId: target.sessionId,
    });
  target.admission = admission ? { ...admission } : undefined;
  const claim = actor.sessions.captureCurrent(target.sessionKey);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    actor.assertCurrent();
    authority.assertCurrent();
    claim.assertCurrent();
  };
  assertCurrent();
  return {
    actor,
    target,
    authority: {
      assertCurrent,
      authorize: (stage, facts) => authority.authorize?.(stage, facts),
    } satisfies IncognitoSessionAuthority,
  };
}
